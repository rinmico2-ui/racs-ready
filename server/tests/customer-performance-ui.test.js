'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/customer-performance.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const row = { id: '507f191e810c19729de860ea', name: '<img src=x onerror=alert(1)>', email: 'fixture@example.test',
  completedBookings: 1, completedOrders: 1, completedTransactions: 2, lifetimeBookings: 3, lifetimeOrders: 2, lifetimeTransactions: 5,
  recordedSpending: 100.25, lifetimeSpending: 300.75, periodLastActivity: '2026-10-08', lastActivity: '2026-10-08',
  serviceValue: 50.25, orderValue: 50, productValue: 45, orderFees: 5, refunds: 0, discounts: 10,
  cancelledBookings: 0, noShows: 0, cancelledOrders: 0, refundedBookings: 0, refundedOrders: 0,
  createdAt: '2025-01-01', engagement: 'Active', accountStatus: 'Active account', daysSinceLastActivity: 1 };
const period = { range: '3months', from: '2026-07-08T16:00:00Z', to: '2026-10-09T12:00:00Z', inactiveDays: 90 };
const report = (list = 'records') => ({ period, asOf: period.to, summary: { totalCustomers: 30, frequentCustomers: 1, neverEngaged: 8, inactive: 3 },
  leaders: { booker: row, buyer: row }, customers: { list, filters: { search: 'fixture', segment: 'all', sort: list === 'lowest' ? 'least' : 'transactions' }, page: 2, pageSize: 25, total: 30, rows: [row] }, methodology: 'Fixture methodology' });
const profile = () => ({ period, asOf: period.to, customer: { ...row, loyalty: { enabled: true, qualifiedRules: [], progress: { nextTier: 'Silver', value: 4, target: 5 } } },
  bookings: { rows: [], page: 1, pageSize: 20, total: 0 }, orders: { rows: [], page: 1, pageSize: 20, total: 0 },
  servicePreferences: [{ name: '<script>unsafe</script>', bookings: 1 }], productPreferences: [{ name: 'Carrier', units: 1, orders: 1 }],
  collections: { gross: 100, paymentRefunds: 0, itemRefunds: 0, refunds: 0, net: 100 }, note: 'Fixture note' });

async function fixture(initialUrl, responses, profileId = '') {
  const elements = new Map(), requests = [], buttons = [];
  const node = id => {
    if (!elements.has(id)) {
      const handlers = {}, flags = new Set();
      elements.set(id, { dataset: {}, hidden: false, disabled: false, innerHTML: '', textContent: '', attributes: {},
        classList: { toggle: (name, value) => value ? flags.add(name) : flags.delete(name) },
        addEventListener: (name, handler) => { handlers[name] = handler; },
        setAttribute(name, value) { this.attributes[name] = value; },
        async fire(name = 'click') { handlers[name]({ preventDefault() {} }); await tick(); },
      });
    }
    return elements.get(id);
  };
  const form = (id, defaults) => {
    const element = node(id);
    element.elements = Object.fromEntries(Object.entries(defaults).map(([name, value]) => { const control = node(id + '.' + name); control.value = value; return [name, control]; }));
    element.elements.namedItem = key => element.elements[key];
    element.reset = () => Object.entries(defaults).forEach(([key, value]) => { element.elements[key].value = value; });
    return element;
  };
  form('cpPeriodForm', { range: 'all', from: '', to: '', inactiveDays: '90' });
  form('cpTableFilters', { search: '', segment: 'all', sort: 'transactions' });
  form('cpHistoryFilters', { bookingStatus: 'successful', orderStatus: 'successful', fromDate: '', toDate: '', historySort: 'recent' });
  ['frequent', 'records', 'lowest'].forEach(view => { const button = node(view); button.dataset.cpView = view; buttons.push(button); });
  const root = node('root'); root.dataset.customerId = profileId; root.querySelectorAll = () => buttons;
  const window = { location: new URL(initialUrl), history: { replaceState(_data, _title, url) { window.location = new URL(url); } } };
  class FormData {
    constructor(element) { this.element = element; }
    get(key) { return this.element.elements[key]?.value; }
  }
  vm.runInNewContext(source, {
    document: { querySelector: () => root, getElementById: node }, window, URL, URLSearchParams, AbortController, Intl, FormData,
    fetch: async (url, options) => {
      requests.push({ url, options }); const next = responses.shift();
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      return { ok: true, json: async () => next };
    },
  });
  await tick();
  return { node, window, requests, buttons };
}

test('customer table preserves cents, escapes names, and returns from View to the actual clamped page', async () => {
  const f = await fixture('http://localhost:5000/admin/reports/customers?range=3months&list=records&page=999&search=fixture', [report(), report('lowest')]);
  const rows = f.node('cpCustomerRows').innerHTML;
  assert.ok(rows.includes('100.25')); assert.ok(rows.includes('300.75')); assert.ok(rows.includes('&lt;img'));
  assert.ok(!rows.includes('<img')); assert.ok(rows.includes('page=2')); assert.ok(!rows.includes('page=999'));
  assert.equal(f.node('records').attributes['aria-pressed'], 'true'); assert.equal(f.node('root').attributes['aria-busy'], 'false');
  await f.node('lowest').fire();
  const requested = new URL(f.requests[1].url, 'http://localhost:5000');
  assert.equal(requested.searchParams.get('list'), 'lowest'); assert.equal(requested.searchParams.get('sort'), 'least');
  assert.equal(requested.searchParams.get('search'), 'fixture'); assert.equal(requested.searchParams.has('page'), false);
  assert.equal(f.node('lowest').attributes['aria-pressed'], 'true');
  assert.ok(f.node('cpCustomerHead').innerHTML.includes('Days since'));
});

test('profile renders separate period/lifetime evidence, remaining loyalty requirements, and a filtered return link', async () => {
  const f = await fixture('http://localhost:5000/admin/reports/customers/' + row.id + '?range=3months&list=records&page=2&search=fixture&bookingPage=3', [profile()], row.id);
  assert.ok(f.node('cpSelectedSummary').innerHTML.includes('100.25')); assert.ok(f.node('cpLifetimeSummary').innerHTML.includes('300.75'));
  assert.ok(f.node('cpLoyalty').innerHTML.includes('1 more qualifying completions needed'));
  assert.ok(f.node('cpServicePreferences').innerHTML.includes('&lt;script&gt;')); assert.ok(!f.node('cpServicePreferences').innerHTML.includes('<script>'));
  assert.ok(f.node('cpBack').href.includes('list=records')); assert.ok(f.node('cpBack').href.includes('page=2'));
  assert.ok(f.node('cpBack').href.includes('search=fixture')); assert.ok(!f.node('cpBack').href.includes('bookingPage'));
});

test('failed refresh keeps the previous report explicitly marked and Retry recovers', async () => {
  const f = await fixture('http://localhost:5000/admin/reports/customers', [report(), new Error('Network unavailable'), report()]);
  const rows = f.node('cpCustomerRows').innerHTML;
  await f.node('cpTableFilters').fire('submit');
  assert.equal(f.node('cpCustomerRows').innerHTML, rows);
  assert.ok(f.node('cpState').textContent.includes('previously loaded report')); assert.equal(f.node('cpRetry').hidden, false);
  await f.node('cpRetry').fire();
  assert.equal(f.node('cpState').hidden, true); assert.equal(f.node('cpRetry').hidden, true);
});

test('a slow earlier response cannot overwrite a newer selected view', async () => {
  let finishEarlier;
  const earlier = new Promise(resolve => { finishEarlier = resolve; });
  const f = await fixture('http://localhost:5000/admin/reports/customers', [() => earlier, report('lowest')]);
  await f.node('lowest').fire();
  assert.equal(f.requests[0].options.signal.aborted, true);
  finishEarlier({ ok: true, json: async () => report('frequent') }); await tick();
  assert.equal(f.node('cpTableTitle').textContent, 'Lowest Customer Engagement');
  assert.equal(f.node('lowest').attributes['aria-pressed'], 'true');
});
