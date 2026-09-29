#!/usr/bin/env node
"use strict";

const { monitorEventLoopDelay } = require("node:perf_hooks");

function envJson(name, fallback) {
  if (!process.env[name]) return fallback;
  try { return JSON.parse(process.env[name]); }
  catch { throw new Error(`${name} must contain valid JSON.`); }
}

function percentile(sorted, value) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

function render(value, variables) {
  return String(value).replace(/\{\{(id|run|email|token)\}\}/g, (_match, key) => variables[key] || "");
}

async function executeLevel({ baseUrl, path, method, bodyTemplate, headerTemplate, expected, level, run, tokens }) {
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const responses = await Promise.all(Array.from({ length: level }, async (_unused, index) => {
    const variables = {
      id: String(index + 1),
      run: String(run),
      email: `load-${run}-${index + 1}@example.test`,
      token: tokens[index % Math.max(1, tokens.length)] || "",
    };
    const requestStarted = performance.now();
    try {
      const headers = Object.fromEntries(
        Object.entries(headerTemplate).map(([key, value]) => [key, render(value, variables)]),
      );
      const body = bodyTemplate === null ? undefined : render(JSON.stringify(bodyTemplate), variables);
      const response = await fetch(new URL(render(path, variables), baseUrl), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(Number(process.env.LOAD_TEST_TIMEOUT_MS) || 30_000),
      });
      await response.arrayBuffer();
      return { status: response.status, ms: performance.now() - requestStarted };
    } catch (error) {
      return { status: "network_error", ms: performance.now() - requestStarted, error: error.message };
    }
  }));
  eventLoop.disable();

  const elapsedMs = performance.now() - started;
  const latencies = responses.map(item => item.ms).sort((a, b) => a - b);
  const statuses = responses.reduce((summary, item) => {
    summary[item.status] = (summary[item.status] || 0) + 1;
    return summary;
  }, {});
  const unexpected = responses.filter(item => !expected.has(Number(item.status))).length;
  return {
    concurrency: level,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    requestsPerSecond: Number((level / (elapsedMs / 1000)).toFixed(2)),
    latencyMs: {
      p50: Number(percentile(latencies, 0.5).toFixed(2)),
      p95: Number(percentile(latencies, 0.95).toFixed(2)),
      p99: Number(percentile(latencies, 0.99).toFixed(2)),
      max: Number(latencies[latencies.length - 1].toFixed(2)),
    },
    statuses,
    unexpected,
    clientEventLoopP99Ms: Number((eventLoop.percentile(99) / 1e6).toFixed(2)),
    clientRssDeltaBytes: process.memoryUsage().rss - rssBefore,
  };
}

async function main() {
  const baseUrl = process.env.LOAD_TEST_BASE_URL;
  if (!baseUrl) throw new Error("Set LOAD_TEST_BASE_URL to an isolated test deployment.");
  const path = process.env.LOAD_TEST_PATH || "/health";
  const method = String(process.env.LOAD_TEST_METHOD || "GET").toUpperCase();
  const levels = String(process.env.LOAD_TEST_LEVELS || "10,25,50,100")
    .split(",").map(Number).filter(value => Number.isSafeInteger(value) && value > 0);
  const expected = new Set(String(process.env.LOAD_TEST_EXPECT || "200").split(",").map(Number));
  const bodyTemplate = envJson("LOAD_TEST_BODY", null);
  const headerTemplate = envJson(
    "LOAD_TEST_HEADERS",
    bodyTemplate === null ? {} : { "Content-Type": "application/json" },
  );
  const tokens = envJson("LOAD_TEST_TOKENS", []);
  const run = Date.now();

  const results = [];
  for (const level of levels) {
    results.push(await executeLevel({
      baseUrl, path, method, bodyTemplate, headerTemplate, expected, level, run, tokens,
    }));
  }
  process.stdout.write(`${JSON.stringify({ baseUrl, path, method, results }, null, 2)}\n`);
  if (results.some(result => result.unexpected > 0)) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`Load test configuration failed: ${error.message}\n`);
  process.exitCode = 1;
});
