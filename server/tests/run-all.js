const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const testDirectory = __dirname;
const testFiles = fs
  .readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDirectory, name));

if (!testFiles.length) {
  console.error("No test files were found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});

if (result.error) {
  console.error("Unable to start the test runner:", result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
