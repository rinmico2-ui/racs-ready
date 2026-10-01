"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMongoConnectionUri, isTlsProtectedMongoUri, isSingleLabelMongoUri, parseDirectHosts } = require("../utils/mongoConnection");

test("requires TLS on production MongoDB URIs", () => {
  assert.equal(isTlsProtectedMongoUri("mongodb+srv://cluster.example/app"), true);
  assert.equal(isTlsProtectedMongoUri("mongodb+srv://cluster.example/app?tls=false"), false);
  assert.equal(isTlsProtectedMongoUri("mongodb://db.example:27017/app?tls=true"), true);
  assert.equal(isTlsProtectedMongoUri("mongodb://db.example:27017/app"), false);
});

test("limits the plaintext opt-in to a single Docker-style hostname", () => {
  assert.equal(isSingleLabelMongoUri("mongodb://user:pass@mongo-service:27017/app?authSource=admin"), true);
  assert.equal(isSingleLabelMongoUri("mongodb://user:pass@45.85.146.21:12131/?directConnection=true"), false);
  assert.equal(isSingleLabelMongoUri("mongodb://2130706433:27017/app"), false);
  assert.equal(isSingleLabelMongoUri("mongodb://user:pass@db.example.com:27017/app"), false);
  assert.equal(isSingleLabelMongoUri("mongodb://user:pass@mongo-a:27017,mongo-b:27017/app"), false);
  assert.equal(isSingleLabelMongoUri("mongodb+srv://cluster.example/app"), false);
});

test("keeps the configured MongoDB URI when no direct hosts are supplied", () => {
  const original = "mongodb+srv://user:secret@cluster.example/app";
  assert.deepEqual(buildMongoConnectionUri(original), { uri: original, usesDirectHosts: false });
});

test("builds a credential-preserving Atlas URI that bypasses SRV lookup", () => {
  const result = buildMongoConnectionUri(
    "mongodb+srv://user:p%40ss@cluster.example/app?retryWrites=true&w=majority",
    {
      directHosts: "node-a.example:27017,node-b.example:27017",
      replicaSet: "atlas-test-shard-0",
    },
  );

  assert.equal(result.usesDirectHosts, true);
  assert.match(result.uri, /^mongodb:\/\/user:p%40ss@node-a\.example:27017,node-b\.example:27017\/app\?/);
  assert.match(result.uri, /retryWrites=true/);
  assert.match(result.uri, /tls=true/);
  assert.match(result.uri, /authSource=admin/);
  assert.match(result.uri, /replicaSet=atlas-test-shard-0/);
});

test("rejects malformed direct MongoDB hosts", () => {
  assert.throws(() => parseDirectHosts("node-a.example:27017/?secret=yes"), /hostname:port list/);
});
