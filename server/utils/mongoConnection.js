"use strict";

function parseDirectHosts(value) {
  const hosts = String(value || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  if (!hosts.length) return [];
  const validHost = /^[a-z0-9.-]+:\d{1,5}$/i;
  if (hosts.some((host) => !validHost.test(host))) {
    throw new Error("MONGODB_DIRECT_HOSTS must be a comma-separated hostname:port list.");
  }
  return hosts;
}

function isTlsProtectedMongoUri(value) {
  const uri = String(value || "");
  if (uri.startsWith("mongodb+srv://")) return true;
  if (!uri.startsWith("mongodb://")) return false;
  const query = uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "";
  const params = new URLSearchParams(query);
  return params.get("tls") === "true" || params.get("ssl") === "true";
}

function buildMongoConnectionUri(srvUri, options = {}) {
  const directHosts = parseDirectHosts(options.directHosts);
  if (!directHosts.length || !String(srvUri || "").startsWith("mongodb+srv://")) {
    return { uri: srvUri, usesDirectHosts: false };
  }

  const parsed = new URL(srvUri);
  const replicaSet = String(options.replicaSet || "").trim();
  if (!/^[a-z0-9_-]+$/i.test(replicaSet)) {
    throw new Error("MONGODB_REPLICA_SET is required when MONGODB_DIRECT_HOSTS is configured.");
  }

  const credentials = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  const params = new URLSearchParams(parsed.searchParams);
  params.set("tls", "true");
  params.set("authSource", String(options.authSource || "admin").trim() || "admin");
  params.set("replicaSet", replicaSet);

  return {
    uri: `mongodb://${credentials}${directHosts.join(",")}${parsed.pathname || "/"}?${params.toString()}`,
    usesDirectHosts: true,
  };
}

module.exports = { buildMongoConnectionUri, isTlsProtectedMongoUri, parseDirectHosts };
