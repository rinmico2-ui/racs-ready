"use strict";

function assertAuthenticatedMongoUri(uri) {
  const authority = String(uri || "").replace(/^mongodb(?:\+srv)?:\/\//, "").split(/[/?]/, 1)[0];
  const at = authority.lastIndexOf("@");
  const credentials = at > 0 ? authority.slice(0, at) : "";
  const colon = credentials.indexOf(":");
  if (colon < 1 || colon === credentials.length - 1) {
    throw new Error("Production MongoDB must use authenticated credentials. Configure the private internal connection URL in Dokploy.");
  }
}

function bootstrapAdminCredentials(env = process.env) {
  const email = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  if (!email || typeof password !== "string" || password.length < 14) {
    throw new Error("No admin exists. Set an explicit ADMIN_EMAIL and ADMIN_PASSWORD of at least 14 characters to provision one; no default admin password is permitted.");
  }
  return { email, password };
}

module.exports = { assertAuthenticatedMongoUri, bootstrapAdminCredentials };
