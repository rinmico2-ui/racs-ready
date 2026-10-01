"use strict";

const jwt = require("jsonwebtoken");
const { createBoundedWindow, positiveLimit } = require("./boundedWindow");
const { createWorkLimiter } = require("./workLimiter");

function authToken(header) {
  const cookie = String(header || "").split(";").find(part => part.trim().startsWith("auth_token="));
  if (!cookie) return "";
  return decodeURIComponent(cookie.trim().slice("auth_token=".length));
}

function createSocketTrafficProtection(options = {}) {
  const secret = options.secret;
  const origins = new Set((options.allowedOrigins || []).map(value => new URL(value).origin));
  const maxConnections = positiveLimit(options.maxConnections ?? process.env.SOCKET_MAX_CONNECTIONS, 300);
  const maxPerUser = positiveLimit(options.maxPerUser ?? process.env.SOCKET_MAX_CONNECTIONS_PER_USER, 12);
  const handshakes = createBoundedWindow({
    limit: positiveLimit(options.handshakeLimit ?? process.env.SOCKET_HANDSHAKE_RATE_LIMIT, 60),
    windowMs: 60000, maxKeys: 10000, now: options.now || Date.now,
  });
  const packets = createBoundedWindow({ limit: 60, windowMs: 10000, maxKeys: 10000, now: options.now || Date.now });
  const gpsPackets = createBoundedWindow({ limit: 10, windowMs: 10000, maxKeys: 10000, now: options.now || Date.now });
  const gpsWork = createWorkLimiter({
    limit: positiveLimit(options.maxGpsWork ?? process.env.SOCKET_MAX_CONCURRENT_GPS_UPDATES, 16),
    perKeyLimit: 1,
  });
  const connectionsByUser = new Map();
  let rejectedHandshakes = 0;
  let droppedPackets = 0;

  function allowRequest(req, callback, connectionCount) {
    try {
      if (connectionCount >= maxConnections) throw new Error("capacity");
      const origin = req.headers.origin;
      if (origin) {
        const normalized = new URL(origin).origin;
        const allowed = origins.size ? origins.has(normalized)
          : normalized === `http://${req.headers.host}`;
        if (!allowed) throw new Error("origin");
      }
      const token = authToken(req.headers.cookie);
      if (!token || token.length > 4096) throw new Error("token");
      const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
      if (!/^[a-f0-9]{24}$/i.test(String(payload.id || ""))) throw new Error("identity");
      const id = String(payload.id);
      if ((connectionsByUser.get(id) || 0) >= maxPerUser || !handshakes.consume(id).allowed) throw new Error("limit");
      req.socketTrafficUserId = id;
      return callback(null, true);
    } catch (_error) {
      rejectedHandshakes += 1;
      return callback("Connection not allowed", false);
    }
  }

  function trackConnection(connection) {
    const id = connection.request.socketTrafficUserId;
    if (!id) return;
    connectionsByUser.set(id, (connectionsByUser.get(id) || 0) + 1);
    connection.once("close", () => {
      const remaining = (connectionsByUser.get(id) || 1) - 1;
      if (remaining) connectionsByUser.set(id, remaining);
      else connectionsByUser.delete(id);
    });
  }

  function protectPackets(socket) {
    const id = String(socket.user._id);
    socket.use((packet, next) => {
      if (!packets.consume(id).allowed) {
        droppedPackets += 1;
        socket.disconnect(true);
        return;
      }
      if (packet[0] === "gps:update" || packet[0] === "tech:location") {
        if (!packet[1] || typeof packet[1] !== "object" || Array.isArray(packet[1]) || !gpsPackets.consume(id).allowed) {
          droppedPackets += 1;
          return;
        }
      }
      next();
    });
  }

  function wrapGpsHandler(socket, handler) {
    return data => gpsWork.run(String(socket.user._id), () => handler(data)).catch(error => {
      if (error.code !== "WORK_CAPACITY_EXCEEDED") throw error;
      droppedPackets += 1;
    });
  }

  return {
    allowRequest, trackConnection, protectPackets, wrapGpsHandler,
    snapshot: () => ({ connectedUsers: connectionsByUser.size, activeGpsUpdates: gpsWork.active, rejectedHandshakes, droppedPackets }),
  };
}

module.exports = { createSocketTrafficProtection };
