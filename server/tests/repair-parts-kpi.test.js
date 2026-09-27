const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Tool = require('../models/Tool');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('repair-parts stock status is derived from quantity instead of stale status', () => {
  assert.equal(
    Tool.effectiveStockStatus({ quantity: 0, minStockLevel: 3, status: 'in_stock' }),
    'out_of_stock',
  );
  assert.equal(
    Tool.effectiveStockStatus({ quantity: 3, minStockLevel: 3, status: 'in_stock' }),
    'low_stock',
  );
  assert.equal(
    Tool.effectiveStockStatus({ quantity: 4, minStockLevel: 3, status: 'out_of_stock' }),
    'in_stock',
  );
  assert.equal(
    Tool.effectiveStockStatus({ quantity: 0, minStockLevel: 3, status: 'discontinued' }),
    'discontinued',
  );
});

test('repair-parts API returns a canonical stock summary', () => {
  const controller = read('controllers/adminController.js');

  assert.match(controller, /tool\.status\s*=\s*Tool\.effectiveStockStatus\(tool\)/);
  assert.match(controller, /const stockSummary\s*=\s*\{/);
  assert.match(controller, /outOfStock:\s*activeTools\.filter\(\(tool\)\s*=>\s*tool\.status\s*===\s*"out_of_stock"\)\.length/);
  assert.match(controller, /res\.json\(\{ tools, count: tools\.length, stockSummary \}\)/);
});

test('repair-parts page uses the same derived state for cards, filters, and badges', () => {
  const page = read('views/pages/admin/Inventory/RepairParts.ejs');

  assert.match(page, /const effectiveStockStatus\s*=\s*\(p\)\s*=>/);
  assert.match(page, /allParts\.map\(part\s*=>\s*\(\{ \.\.\.part, status: effectiveStockStatus\(part\) \}\)\)/);
  assert.match(page, /outOfStock:\s*active\.filter\(p\s*=>\s*effectiveStockStatus\(p\)\s*===\s*'out_of_stock'\)\.length/);
  assert.match(page, /stockLevelFilter\s*===\s*'low_stock'\s*&&\s*stockStatus\s*!==\s*'low_stock'/);
  assert.match(page, /rp-stock \$\{stockStatus\}/);
});

test('inventory trend snapshots use the canonical inclusive threshold', () => {
  const routes = read('routes/inventoryRoutes.js');
  assert.match(routes, /Tool\.effectiveStockStatus\(\{ \.\.\.t, quantity: qty \}\)/);
});
