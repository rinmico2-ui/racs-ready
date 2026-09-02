"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMongoConnectionUri, parseDirectHosts } = require("../utils/mongoConnection");

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
