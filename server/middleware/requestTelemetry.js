"use strict";

const crypto = require("crypto");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const logger = require("../utils/logger").create("http");

const startedAt = new Date();
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

const state = {
  totalRequests: 0,
  activeRequests: 0,
  peakActiveRequests: 0,
  responses: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
  latency: { count: 0, totalMs: 0, maxMs: 0, over500Ms: 0, over2000Ms: 0, samples: [] },
  databasePool: { checkedOut: 0, peakCheckedOut: 0, waitQueueEntered: 0, checkoutFailures: 0 },
};

function safeRequestId(value) {
  const candidate = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{8,100}$/.test(candidate) ? candidate : crypto.randomUUID();
}

function statusClass(statusCode) {
  const group = Math.floor(Number(statusCode || 500) / 100);
  return group >= 2 && group <= 5 ? `${group}xx` : "5xx";
}

function requestTelemetry(req, res, next) {
  const requestId = safeRequestId(req.headers["x-request-id"]);
  const started = process.hrtime.bigint();
  req.requestId = requestId;
  req.auditRequestId = req.auditRequestId || requestId;
  res.setHeader("X-Request-Id", requestId);

  state.totalRequests += 1;
  state.activeRequests += 1;
  state.peakActiveRequests = Math.max(state.peakActiveRequests, state.activeRequests);

  let finished = false;
  const record = () => {
    if (finished) return;
    finished = true;
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    state.responses[statusClass(res.statusCode)] += 1;
    state.latency.count += 1;
    state.latency.totalMs += elapsedMs;
    state.latency.maxMs = Math.max(state.latency.maxMs, elapsedMs);
    state.latency.samples.push(elapsedMs);
    if (state.latency.samples.length > 2000) state.latency.samples.shift();
    if (elapsedMs >= 500) state.latency.over500Ms += 1;
    if (elapsedMs >= 2000) state.latency.over2000Ms += 1;

    logger.http(
      "requestId=%s method=%s path=%s status=%d durationMs=%d active=%d userId=%s",
      requestId,
      req.method,
      String(req.path || "/").slice(0, 500),
      res.statusCode,
      Math.round(elapsedMs),
      state.activeRequests,
      req.user?._id ? String(req.user._id) : "anonymous",
    );
  };
  res.once("finish", record);
  res.once("close", record);
  next();
}

function runtimeSnapshot() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const latencyCount = state.latency.count || 1;
  const nsToMs = value => Number.isFinite(value) ? Number((value / 1e6).toFixed(2)) : 0;
  const samples = [...state.latency.samples].sort((a, b) => a - b);
  const percentile = value => {
    if (!samples.length) return 0;
    return Number(samples[Math.min(samples.length - 1, Math.ceil((value / 100) * samples.length) - 1)].toFixed(2));
  };
  return {
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    requests: {
      total: state.totalRequests,
      active: state.activeRequests,
      peakActive: state.peakActiveRequests,
      responses: { ...state.responses },
    },
    latencyMs: {
      average: Number((state.latency.totalMs / latencyCount).toFixed(2)),
      p95: percentile(95),
      p99: percentile(99),
      max: Number(state.latency.maxMs.toFixed(2)),
      over500: state.latency.over500Ms,
      over2000: state.latency.over2000Ms,
    },
    eventLoopDelayMs: {
      mean: nsToMs(eventLoop.mean),
      p95: nsToMs(eventLoop.percentile(95)),
      p99: nsToMs(eventLoop.percentile(99)),
      max: nsToMs(eventLoop.max),
    },
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    },
    cpuTimeMs: {
      user: Number((cpu.user / 1000).toFixed(2)),
      system: Number((cpu.system / 1000).toFixed(2)),
    },
    databasePool: { ...state.databasePool },
  };
}

function trackMongoPool(client) {
  if (!client || client.__racsPoolTelemetryAttached) return;
  Object.defineProperty(client, "__racsPoolTelemetryAttached", { value: true });
  client.on("connectionCheckedOut", () => {
    state.databasePool.checkedOut += 1;
    state.databasePool.peakCheckedOut = Math.max(
      state.databasePool.peakCheckedOut,
      state.databasePool.checkedOut,
    );
  });
  client.on("connectionCheckedIn", () => {
    state.databasePool.checkedOut = Math.max(0, state.databasePool.checkedOut - 1);
  });
  client.on("connectionCheckOutStarted", () => { state.databasePool.waitQueueEntered += 1; });
  client.on("connectionCheckOutFailed", () => { state.databasePool.checkoutFailures += 1; });
}

module.exports = { requestTelemetry, runtimeSnapshot, safeRequestId, trackMongoPool };
