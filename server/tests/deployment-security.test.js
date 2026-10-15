"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const sensitivePaths = require("../middleware/sensitivePaths");
const { assertAuthenticatedMongoUri, bootstrapAdminCredentials } = require("../utils/deploymentSecurity");
const { isTlsProtectedMongoUri } = require("../utils/mongoConnection");

test("production MongoDB configuration requires a username and password", () => {
  for (const uri of ["mongodb://mongo:27017/test", "mongodb://user@mongo/test", "mongodb://user:@mongo/test"]) {
    assert.throws(() => assertAuthenticatedMongoUri(uri), /authenticated credentials/);
  }
  assert.doesNotThrow(() => assertAuthenticatedMongoUri("mongodb://user:escaped%40password@mongo:27017/test?authSource=admin"));
});

test("TLS connections reject disabled certificate and hostname verification", () => {
  assert.equal(isTlsProtectedMongoUri("mongodb+srv://user:password@cluster.example.com/test"), true);
  for (const option of ["tlsInsecure", "tlsAllowInvalidCertificates", "tlsAllowInvalidHostnames"]) {
    assert.equal(isTlsProtectedMongoUri(`mongodb://user:password@cluster.example.com/test?tls=true&${option}=true`), false);
  }
});

test("admin bootstrap never uses a known default password or missing configuration", () => {
  assert.throws(() => bootstrapAdminCredentials({}), /no default admin password/);
  assert.throws(() => bootstrapAdminCredentials({ ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "ChangeMe123!" }), /at least 14/);
  assert.deepEqual(bootstrapAdminCredentials({ ADMIN_EMAIL: "ADMIN@example.com", ADMIN_PASSWORD: "explicit-long-random-password" }), { email: "admin@example.com", password: "explicit-long-random-password" });
});

test("secret, repository, and database archive paths fail before database middleware", () => {
  for (const pathname of ["/.env", "/.%65nv", "/.env.production", "/.git/config", "/images/.ENV", "/node_modules/mongoose/package.json", "/uploads/backup.archive.gz", "/data.dump", "/database.sql"]) {
    let status;
    let advanced = false;
    const res = { set() {}, status(code) { status = code; return this; }, end() {} };
    sensitivePaths({ path: pathname }, res, () => { advanced = true; });
    assert.equal(status, 404, pathname);
    assert.equal(advanced, false, pathname);
  }
});

test("public assets, protected evidence, and certificate challenges remain routable", () => {
  for (const pathname of ["/js/login.js", "/.well-known/acme-challenge/token", "/uploads/payments/receipt.jpg", "/api/admin/inventory/template.csv"]) {
    let advanced = false;
    sensitivePaths({ path: pathname }, {}, () => { advanced = true; });
    assert.equal(advanced, true, pathname);
  }
});
