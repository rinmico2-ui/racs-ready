"use strict";
require("dotenv").config({ quiet: true });
const { deploymentSecretIssues } = require("../utils/deploymentSecrets");
const issues = deploymentSecretIssues();
if (issues.length) {
  for (const issue of issues) console.error(issue);
  process.exitCode = 1;
} else console.log("Deployment secret checks passed. No secret values were printed.");
