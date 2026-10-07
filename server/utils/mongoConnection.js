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
  if (!uri.startsWith("mongodb+srv://") && !uri.startsWith("mongodb://")) return false;
  const query = uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "";
  const params = new URLSearchParams(query);
  if (params.get("tls") === "false" || params.get("ssl") === "false") return false;
  if (uri.startsWith("mongodb+srv://")) return true;
  return params.get("tls") === "true" || params.get("ssl") === "true";
}

// Dokploy's internal MongoDB host is a Docker service name, not a public IP or DNS name.
// This check is only used with an explicit production opt-in for a private network.
function isSingleLabelMongoUri(value) {
  const uri = String(value || "");
  if (!uri.startsWith("mongodb://")) return false;
  const authority = uri.slice("mongodb://".length).split(/[/?]/, 1)[0];
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$/i.test(host);
}

// A mongodb:// URI without an explicit replica set may point at a standalone
// or MongoDB-compatible server. Disable retryable writes even when the URI
// omits directConnection or has no query string. Replica-set/SRV URIs retain
// their configured retry policy.
function disableRetryableWritesForDirectConnection(value) {
  const uri = String(value || "");
  if (!uri.startsWith("mongodb://")) return uri;
  const queryIndex = uri.indexOf("?");
  const params = new URLSearchParams(queryIndex >= 0 ? uri.slice(queryIndex + 1) : "");
  if (params.has("replicaSet")) return uri;
  if (params.get("retryWrites") === "false") return uri;
  params.set("retryWrites", "false");
  return `${queryIndex >= 0 ? uri.slice(0, queryIndex) : uri}?${params.toString()}`;
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

module.exports = { buildMongoConnectionUri, disableRetryableWritesForDirectConnection, isTlsProtectedMongoUri, isSingleLabelMongoUri, parseDirectHosts };
