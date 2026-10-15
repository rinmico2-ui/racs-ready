"use strict";
const User = require("../models/User");
const { isAccountEnabled } = require("../middleware/accountState");
const Role = require("../models/Role");
const { allowedPermissionsForRole } = require("../middleware/requirePermission");

function validSocketAccount(socket, user, now = Date.now()) {
  const token = socket.authPayload;
  if (!token || !Number.isFinite(token.exp) || token.exp * 1000 <= now || !isAccountEnabled(user)) return false;
  if (token.sessionId && token.sessionId !== String(user.currentSessionId || "")) return false;
  if (user.lastPasswordChange && (!token.iat || token.iat * 1000 < new Date(user.lastPasswordChange).getTime())) return false;
  // A role or permission edit requires a fresh handshake and fresh rooms.
  return JSON.stringify([user.role, user.permissionsOverridden, user.permissions || []])
    === JSON.stringify([socket.user.role, socket.user.permissionsOverridden, socket.user.permissions || []]);
}

function installSocketAuthorization(io, options = {}) {
  const load = options.load || (ids => User.find({ _id: { $in: ids } })
    .select("active blocked emailVerified currentSessionId lastPasswordChange role permissions permissionsOverridden")
    .maxTimeMS(1500).lean());
  const now = options.now || Date.now;
  const loadRoles = options.loadRoles || (() => Role.find({ name: { $in: ["secretary", "technician"] } }).select("name permissions").maxTimeMS(1500).lean());
  let running = null;
  let checkedAt = 0;
  const intervalMs = 5000;
  async function refresh() {
    if (running) return running;
    running = (async () => {
      const sockets = [...io.sockets.sockets.values()];
      if (!sockets.length) { checkedAt = now(); return; }
      try {
        const users = new Map((await load([...new Set(sockets.map(socket => String(socket.user._id)))])).map(user => [String(user._id), user]));
        const roles = sockets.some(socket => ["secretary", "technician"].includes(socket.user.role) && socket.permissionFingerprint !== undefined)
          ? new Map((await loadRoles()).map(role => [role.name, role.permissions || []])) : new Map();
        for (const socket of sockets) {
          const user = users.get(String(socket.user._id));
          let valid = validSocketAccount(socket, user, now());
          if (valid && socket.permissionFingerprint !== undefined) {
            const allowed = allowedPermissionsForRole(user.role);
            const permissions = user.role === "admin" ? allowed
              : user.permissionsOverridden === true || user.permissions?.length ? user.permissions || [] : roles.get(user.role) || [];
            const fingerprint = JSON.stringify([...new Set(permissions.filter(key => allowed.includes(key)))].sort());
            valid = fingerprint === socket.permissionFingerprint;
          }
          if (!valid) socket.disconnect(true);
        }
        checkedAt = now();
      } catch {
        for (const socket of sockets) socket.disconnect(true);
      }
    })();
    try { await running; } finally { running = null; }
  }
  function protect(socket) {
    socket.use(async (_packet, next) => {
      if (socket.authPayload?.exp * 1000 <= now()) { socket.disconnect(true); return; }
      if (now() - checkedAt >= intervalMs) await refresh();
      if (socket.connected) next();
    });
  }
  const timer = setInterval(() => { void refresh(); }, intervalMs);
  timer.unref();
  io.httpServer?.once("close", () => clearInterval(timer));
  return { protect, refresh, stop: () => clearInterval(timer) };
}
function disconnectUser(req, userId) {
  if (userId) req.app?.get?.("io")?.in(`user:${userId}`).disconnectSockets(true);
}
module.exports = { validSocketAccount, installSocketAuthorization, disconnectUser };
