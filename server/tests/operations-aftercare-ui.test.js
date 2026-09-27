"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("resolution center opens order details in place", () => {
  const page = read("views/pages/admin/Appointments/AttentionQueue.ejs");
  assert.match(page, /onclick="viewOrderDetail\('\$\{item\.id\}'\)"/);
  assert.match(page, /async function viewOrderDetail\(id\)/);
  assert.match(page, /fetch\(`\/api\/orders\/\$\{encodeURIComponent\(id\)\}\?view=modal`/);
  assert.doesNotMatch(page, /href="\$\{RESOLUTION_ORDERS_PATH\}\?order=/);
});

test("aftercare operations pages share a responsive visual system", () => {
  const warranty = read("views/pages/admin/Warranty/Warranty.ejs");
  const returns = read("views/pages/admin/Warranty/ProductReturns.ejs");
  const maintenance = read("views/pages/admin/Maintenance/Maintenance.ejs");
  const styles = read("public/css/operations-aftercare.css");

  [warranty, returns, maintenance].forEach(page => assert.match(page, /operations-aftercare\.css\?v=20260927/));
  assert.match(returns, /id="rmaKpiOpen"/);
  assert.match(returns, /class="rma-workspace"/);
  assert.match(maintenance, /maintenance-shell ops-modern/);
  assert.match(styles, /@media\(max-width:640px\)/);
});

test("warranty registry uses accessible counted status tabs", () => {
  const warranty = read("views/pages/admin/Warranty/Warranty.ejs");
  const styles = read("public/css/operations-aftercare.css");

  assert.match(warranty, /class="warranty-status-tabs" role="tablist"/);
  assert.match(warranty, /class="warranty-status-tab active" role="tab" aria-selected="true"/);
  assert.match(warranty, /data-count-status="active"/);
  assert.match(warranty, /class="warranty-type-switch" role="group"/);
  assert.match(warranty, /\['ArrowLeft','ArrowRight','Home','End'\]/);
  assert.match(warranty, /id="warrantyClearFilters"/);
  assert.match(styles, /\.warranty-status-tab\.active/);
});

test("return dashboard summaries are independent from the active filter", () => {
  const route = read("routes/productReturnRoutes.js");
  const client = read("public/js/product-returns-admin.js");
  assert.match(route, /const \[returns, statusCounts\] = await Promise\.all/);
  assert.match(route, /refundDecisions:/);
  assert.match(client, /\$\("rmaKpiOpen"\)\.textContent/);
});
