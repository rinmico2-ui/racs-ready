const fs = require("fs");
const path = require("path");

const srcPath = `C:\\Users\\Marcus Mallari\\.gemini\\antigravity-ide\\brain\\434ff54e-b8f3-477e-9abe-7795cf0b4140\\.system_generated\\steps\\201\\content.md`;
const destPath = `c:\\Users\\Marcus Mallari\\Documents\\Project Capstone 0.5\\server\\public\\js\\qrcode.min.js`;

try {
  const content = fs.readFileSync(srcPath, "utf8");
  const lines = content.split("\n");
  // The minified script starts at line index 14 (which is line 15 in 1-based index)
  const scriptLines = lines.slice(14);
  const scriptContent = scriptLines.join("\n");
  
  fs.writeFileSync(destPath, scriptContent, "utf8");
  console.log("Successfully extracted qrcode.min.js to:", destPath);
  process.exit(0);
} catch (err) {
  console.error("Error extracting qrcode:", err);
  process.exit(1);
}
