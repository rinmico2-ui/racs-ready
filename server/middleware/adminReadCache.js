"use strict";

const { clearAll } = require("../utils/reportCache");
const DEFAULT_PATHS = new Set([
  "/api/admin/navigation-summary", "/api/admin/warranties/stats",
  "/api/admin/resolution-center", "/api/admin/analytics/summary",
  "/api/projects/dashboard",
]);

// Never cache authorization, record details, payment decisions or write results.
// Each process keeps a small, five-second cache of admin-only informational reads.
function createAdminReadCache({ ttlMs = 5000, maxEntries = 128, now = Date.now, paths = DEFAULT_PATHS } = {}) {
  const entries = new Map();
  let generation = 0;
  function invalidate() { generation += 1; entries.clear(); clearAll(); }
  function middleware(req, res, next) {
    const path = String(req.originalUrl || req.url || "").split("?")[0];
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && (path.startsWith("/api/") || path.startsWith("/appointments/"))) {
      invalidate();
      res.once("finish", invalidate);
      return next();
    }
    // Only globally validated administrators may replay a summary. Other roles
    // continue through their route-specific permissions without any cache bypass.
    if (req.method !== "GET" || !req.authResolved || req.user?.role !== "admin" || !paths.has(path)) return next();
    const key = `${req.user._id}:${req.originalUrl || req.url}`;
    const current = entries.get(key);
    const replay = snapshot => {
      if (res.destroyed) return;
      res.set("Cache-Control", "private, no-store");
      res.set("X-Admin-Read-Cache", "hit");
      res.set("Content-Type", "application/json; charset=utf-8");
      return res.send(snapshot);
    };
    if (current && current.snapshot && current.expiresAt > now()) return replay(current.snapshot);
    if (current?.pending) {
      return current.pending.then(snapshot => {
        if (res.destroyed) return;
        return snapshot && current.generation === generation ? replay(snapshot) : next();
      }).catch(next);
    }
    // Do not grow an unbounded pending queue when all slots are occupied.
    if (entries.size >= maxEntries) {
      const removable = [...entries].find(([, value]) => !value.pending);
      if (!removable) return next();
      entries.delete(removable[0]);
    }
    let release;
    const entry = { generation, snapshot: null, pending: new Promise(resolve => { release = resolve; }) };
    entries.set(key, entry);
    const json = res.json;
    res.set("X-Admin-Read-Cache", "miss");
    res.json = function capture(body) {
      if (res.statusCode === 200) entry.snapshot = JSON.stringify(body);
      return json.call(this, body);
    };
    let completed = false;
    function finish() {
      if (completed) return;
      completed = true;
      const successful = res.writableFinished && res.statusCode === 200 && entry.snapshot;
      if (entries.get(key) === entry) {
        if (successful && entry.generation === generation) {
          entry.pending = null;
          entry.expiresAt = now() + ttlMs;
        } else entries.delete(key);
      }
      release(successful ? entry.snapshot : null);
    }
    res.once("finish", finish);
    res.once("close", finish);
    return next();
  }
  middleware.invalidate = invalidate;
  return middleware;
}

module.exports = createAdminReadCache();
module.exports.createAdminReadCache = createAdminReadCache;
