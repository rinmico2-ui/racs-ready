const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'pages', 'admin', 'Inventory', 'POS.ejs'),
  'utf8',
);

test('POS item cards use readable type sizes and high-contrast text colors', () => {
  assert.match(source, /\.pos-item-name\s*\{[^}]*font-size:\s*0\.95rem;[^}]*color:\s*#0f172a;/);
  assert.match(source, /\.pos-item-cat\s*\{[^}]*font-size:\s*0\.78rem;[^}]*color:\s*#475569;/);
  assert.match(source, /\.pos-item-price\s*\{[^}]*color:\s*#15803d;/);
  assert.match(source, /\.pos-item-stock\s*\{[^}]*font-size:\s*0\.78rem;[^}]*color:\s*#475569;/);
  assert.match(source, /\.pos-item-barcode\s*\{[^}]*font-size:\s*0\.75rem;[^}]*color:\s*#475569;/);
});

test('out-of-stock cards keep their text opaque while muting only the image', () => {
  assert.match(source, /\.pos-item\.oos\s*\{[^}]*opacity:\s*1;[^}]*cursor:\s*not-allowed;/);
  assert.match(source, /\.pos-item\.oos \.pos-item-img\s*\{\s*opacity:\s*0\.55;/);
  assert.match(source, /\.pos-item\.oos \.pos-item-stock\s*\{[^}]*color:\s*#b91c1c;/);
  assert.doesNotMatch(source, /\.pos-item\.oos\s*\{[^}]*opacity:\s*0\.4;/);
});

test('POS stylesheet does not contain the stray header selector token', () => {
  assert.doesNotMatch(source, /\.pos-header-title\s*\{[^}]*\}\+/);
});
