const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const viewRoot = path.join(__dirname, "..", "views", "pages", "admin");
const templates = [
  "Reports/ReportCenter.ejs",
  "Reports/RevenueReports.ejs",
  "Reports/ServiceReport.ejs",
  "Reports/OrderReports.ejs",
  "Reports/InventoryReports.ejs",
  "Ratings/service.ejs",
  "Ratings/technicians.ejs",
];

test("admin management reports use the shared KPI component", () => {
  for (const relativePath of templates) {
    const template = fs.readFileSync(path.join(viewRoot, relativePath), "utf8");
    assert.match(template, /\/css\/report-kpis\.css/, `${relativePath} must load the shared KPI stylesheet`);
    assert.match(template, /class="[^"]*report-kpi-grid/, `${relativePath} must use the shared KPI grid`);
    assert.match(template, /class="[^"]*kpi-enterprise/, `${relativePath} must use shared KPI cards`);
  }
});

test("shared KPI component defines consistent layout, accents, and responsive behavior", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "report-kpis.css"), "utf8");
  assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.kpi-enterprise\s*\{/);
  assert.match(css, /min-height:\s*154px/);
  assert.match(css, /\.kpi-enterprise::before\s*\{[^}]*transform:\s*scaleX\(1\)/s);
  assert.doesNotMatch(css, /transform:\s*scaleX\(\.34\)/);
  assert.match(css, /data-accent="orange"/);
  assert.match(css, /@media \(max-width:\s*560px\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
