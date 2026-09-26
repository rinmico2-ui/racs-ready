const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('Accepted order KPI uses its own color treatment instead of forced white', () => {
  const source = read('public/js/admin-aircon-orders.js');
  const render = source.slice(source.indexOf('  function renderStats('), source.indexOf('  function orderCard('));
  const container = { innerHTML: '', querySelectorAll() { return []; } };
  const context = { document: { getElementById() { return container; } } };
  vm.runInNewContext(render + '\nrenderStats("active", [{icon:"bi-check-circle-fill", color:"green", tone:"accepted", label:"Accepted", value:1}]);', context);
  assert.match(container.innerHTML, /stat-icon ao-accepted-stat-icon/);
  assert.match(container.innerHTML, /bi-check-circle-fill" aria-hidden="true"/);
  assert.doesNotMatch(container.innerHTML, /text-white/);
  assert.match(container.innerHTML, /Accepted/);
  vm.runInNewContext('renderStats("active", [{icon:"bi-truck", color:"cyan", label:"En Route", value:1}]);', context);
  assert.match(container.innerHTML, /bi-truck text-white/);
});

test('Accepted check icon and its background have accessible contrast', () => {
  const luminance = hex => {
    const channels = hex.match(/\w\w/g).map(value => parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  assert.ok((luminance('dcfce7') + 0.05) / (luminance('166534') + 0.05) >= 4.5);
  const staff = read('views/pages/admin/Inventory/AirconOrders.ejs');
  assert.match(staff, /\.ao-page \.stat-icon\.ao-accepted-stat-icon\s*\{[^}]*color: #166534;[^}]*background: #dcfce7;/);
  const technician = read('views/pages/technician/technicianorders.ejs');
  assert.match(technician, /\.technician-page \.kpi-enterprise-icon\.accepted\s*\{[^}]*background: #dcfce7; color: #166534;/);
  assert.match(technician, /class="kpi-enterprise-icon accepted"><i class="bi bi-check-circle-fill" aria-hidden="true"/);
  assert.doesNotMatch(technician, /class="kpi-enterprise-icon orange"/);
});

test('updated order views render and scripts parse without errors', async () => {
  const technician = await ejs.renderFile(path.join(__dirname, '../views/pages/technician/technicianorders.ejs'), {});
  for (const match of technician.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    assert.doesNotThrow(() => new vm.Script(match[1]));
  }
  assert.doesNotThrow(() => new vm.Script(read('public/js/admin-aircon-orders.js')));
  for (const role of ['admin', 'secretary']) {
    const html = await ejs.renderFile(path.join(__dirname, '../views/pages/admin/Inventory/AirconOrders.ejs'), { ordersWorkspaceRole: role });
    assert.match(html, /ao-accepted-stat-icon/);
    assert.match(html, /admin-aircon-orders\.js\?v=20260926-accepted-contrast-v4/);
  }
});
