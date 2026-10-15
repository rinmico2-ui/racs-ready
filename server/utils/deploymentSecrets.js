"use strict";
const crypto = require("crypto");
const KNOWN_SAMPLES = {
  "EMAIL_OUTBOX_SECRET": "cef7bc3d7bd8951ffcdf244330550a5680660429141db868258606b3043570ea",
  "ATTENDANCE_QR_SECRET": "cef7bc3d7bd8951ffcdf244330550a5680660429141db868258606b3043570ea"
};
function deploymentSecretIssues(env = process.env) {
  const issues = [];
  const keys = ["JWT_SECRET", "EMAIL_OUTBOX_SECRET", "ATTENDANCE_QR_SECRET"];
  for (const key of keys) {
    const value = env[key];
    if (typeof value !== "string" || value.length < 32 || /^(change.?me|your[_-]|replace[_-])/i.test(value)) issues.push(key + " must be a unique random secret of at least 32 characters.");
    else if (KNOWN_SAMPLES[key] === crypto.createHash("sha256").update("deployment-sample:" + value).digest("hex")) issues.push(key + " still uses the public sample value.");
  }
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    if (env[keys[i]] && env[keys[i]] === env[keys[j]]) issues.push(keys[i] + " and " + keys[j] + " must use different secrets.");
  }
  if (env.EMAIL_OUTBOX_PREVIOUS_SECRET) {
    const until = Date.parse(env.EMAIL_OUTBOX_PREVIOUS_SECRET_UNTIL || "");
    if (!(until > Date.now() && until <= Date.now() + 7 * 86400000)) issues.push("EMAIL_OUTBOX_PREVIOUS_SECRET_UNTIL must be a future time within seven days; remove the previous key after draining the queue.");
  }
  return issues;
}
function assertDeploymentSecrets(env = process.env) {
  const issues = deploymentSecretIssues(env);
  if (issues.length) throw new Error("Unsafe deployment secrets: " + issues.join(" "));
}
module.exports = { assertDeploymentSecrets, deploymentSecretIssues };
