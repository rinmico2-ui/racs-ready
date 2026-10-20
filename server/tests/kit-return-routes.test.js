'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ejs = require('ejs');
const file = path.join(__dirname, '../routes/kitReturnRoutes.js');
function fixture(technician, materialSnapshot = { total: [{ count: 2 }], items: [] }, reportTotal = 0) {
  const routes = [], roles = [], captures = [];
  const chain = { populate() { return this; }, sort() { return this; }, skip(value) { captures.push({ skip: value }); return this; }, limit(value) { captures.push({ limit: value }); return this; }, lean: async () => [] };
  const router = { use() {}, get(url, ...handlers) { routes.push({ method: 'get', url, handlers }); }, post(url, ...handlers) { routes.push({ method: 'post', url, handlers }); } };
  const service = { async reportMaterials(input) { captures.push({ report: input }); return { _id: 'report' }; }, async reportMaterialsBatch(input) { captures.push({ batch: input }); return [{ _id: 'report' }]; }, async reconcile(input) { captures.push({ review: input }); return { _id: 'report', status: 'received' }; }, async reconcileBatch(input) { captures.push({ batchReview: input }); return [{ _id: 'report', status: 'received' }]; } };
  const context = { module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../middleware/authenticate') return { authenticate() {}, requireRole(allowed) { roles.push(allowed); return (req, res, next) => allowed.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }); } };
    if (name === '../middleware/requirePermission') return { requirePermission() { return () => {}; } };
    if (name === '../utils/kitMaterialBalance') return require(name);
    if (name === '../utils/stringSecurity') return require(name);
    if (name === 'mongoose') return require('mongoose');
    if (name === '../models/DailyKit') return { aggregate(pipeline) { captures.push({ pipeline }); return { allowDiskUse: async () => [materialSnapshot] }; } };
    if (['../models/BookingService', '../models/Order'].includes(name)) return { find() { return { select() { return this; }, lean: async () => [] }; } };
    if (name === '../models/KitReturn') return { find(filter) { captures.push({ filter }); return chain; }, countDocuments: async () => reportTotal };
    if (name === '../models/Technician') return { findOne(filter) { captures.push({ technician: filter }); return { select() { return this; }, lean: async () => ({ _id: '507f1f77bcf86cd799439011', user: '507f1f77bcf86cd799439012' }) }; } };
    if (name === '../utils/kitReturnService') return { createService: () => service };
    if (name === '../utils/kitReturnNotifications') return { reported: async () => {}, reviewed: async () => {} };
    if (name === '../utils/audit') return { logEvent: async () => {} };
    throw Error('Unexpected import: ' + name);
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  context.module.exports({ technician, getContext: async () => ({}) });
  return { routes, roles, captures, async call(method, url, req, guard = false) {
    const route = routes.find(row => row.method === method && row.url === url);
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    if (guard) { let allowed = false; route.handlers[0](req, res, () => { allowed = true; }); if (!allowed) return res; }
    await route.handlers.at(-1)(req, res, error => { throw error; }); return res;
  } };
}
test('technician return reports cannot choose another account identity or stock quantity from the form', async () => {
  const f = fixture(true);
  await f.call('post', '/materials', { user: { _id: 'signed-in', role: 'technician' }, returnContext: { technicianIds: ['owned-tech'] }, body: { kitId: 'kit', itemId: 'item', unused: 4, technicianIds: ['victim'], userId: 'admin', status: 'received' } });
  const input = f.captures[0].report;
  assert.deepEqual(Array.from(input.technicianIds), ['owned-tech']);
  assert.equal(input.userId, 'signed-in');
  assert.equal(input.status, undefined);
  assert.equal(f.routes.some(row => row.url === '/:id/review'), false);
});

test('bulk submission uses signed-in scope and is unavailable on the admin router', async () => {
  const tech = fixture(true);
  const res = await tech.call('post', '/materials/batch', { user: { _id: 'signed-in', role: 'technician' }, returnContext: { technicianIds: ['mine'] }, body: { items: [{ kitId: 'kit', itemId: 'material', unused: 2 }], technicianIds: ['victim'], userId: 'spoofed', notes: 'Return unused items.' } });
  assert.equal(res.statusCode, 200); assert.equal(res.body.reports.length, 1);
  assert.deepEqual(Array.from(tech.captures[0].batch.technicianIds), ['mine']);
  assert.equal(tech.captures[0].batch.userId, 'signed-in');
  assert.equal(fixture(false).routes.some(row => row.url === '/materials/batch'), false);
});

test('return all preview includes every page within own scope, skips pending items, and refuses truncation', async () => {
  const techId = '507f1f77bcf86cd799439011', tech = fixture(true, { total: [{ count: 45 }], items: [] });
  const req = { returnContext: { technicianIds: [techId] }, query: { selection: 'all', page: 2 } };
  const res = await tech.call('get', '/materials', req);
  const pipeline = tech.captures[0].pipeline;
  assert.equal(String(pipeline[0].$match.technicianId.$in[0]), techId);
  const selection = pipeline.find(stage => stage.$match?.$expr?.$and);
  assert.match(JSON.stringify(selection), /returnPendingQuantity/);
  assert.equal(pipeline.find(stage => stage.$facet).$facet.items[0].$skip, 0);
  assert.equal(pipeline.find(stage => stage.$facet).$facet.items[1].$limit, 100);
  assert.equal(res.body.pagination.total, 45);
  const tooMany = fixture(true, { total: [{ count: 101 }], items: [] });
  assert.equal((await tooMany.call('get', '/materials', req)).statusCode, 400);
});

test('material categories and literal search filter both result counts and pages, while category totals cover the full kit', async () => {
  const techId = '507f1f77bcf86cd799439011', tech = fixture(true, { total: [{ count: 13 }], items: [], summary: [{ _id: 'repair_part', count: 21 }, { _id: 'consumable', count: 34 }] });
  const req = { returnContext: { technicianIds: [techId] }, query: { category: 'repair_part', search: 'Capacitor [A]+', page: '2', limit: '6', technicianId: 'another-tech' } };
  const result = await tech.call('get', '/materials', req), pipeline = tech.captures[0].pipeline, facet = pipeline.find(stage => stage.$facet).$facet;
  assert.equal(String(pipeline[0].$match.technicianId.$in[0]), techId);
  for (const stages of [facet.total, facet.items]) {
    assert.equal(stages[0].$match['item.category'], 'repair_part');
    assert.equal(stages[1].$match['item.name'].test('Capacitor [A]+'), true);
    assert.equal(stages[1].$match['item.name'].test('Capacitor AAAAA'), false);
  }
  assert.equal(facet.items[2].$skip, 6); assert.equal(facet.items[3].$limit, 6);
  assert.equal(facet.summary[0].$group._id, '$item.category');
  assert.equal(result.body.summary.repair_part, 21); assert.equal(result.body.summary.consumable, 34); assert.equal(result.body.pagination.pages, 3);
});

test('filtered Return all respects category and search across all pages, with bounded page sizes and valid filters', async () => {
  const techId = '507f1f77bcf86cd799439011', tech = fixture(true);
  await tech.call('get', '/materials', { returnContext: { technicianIds: [techId] }, query: { selection: 'all', category: 'consumable', search: 'Cleaner', page: '7' } });
  const facet = tech.captures[0].pipeline.find(stage => stage.$facet).$facet;
  assert.equal(facet.items[0].$match['item.category'], 'consumable'); assert.equal(facet.items[2].$skip, 0); assert.equal(facet.items[3].$limit, 100);
  for (const query of [{ category: 'equipment' }, { category: { $ne: 'consumable' } }, { search: { $ne: '' } }]) {
    assert.equal((await tech.call('get', '/materials', { returnContext: { technicianIds: [techId] }, query })).statusCode, 400);
  }
  const bounded = await tech.call('get', '/materials', { returnContext: { technicianIds: [techId] }, query: { limit: '999999' } });
  assert.equal(bounded.body.pagination.limit, 20);
});

test('bulk receipt route is admin only and ignores a spoofed reviewing actor', async () => {
  const f = fixture(false);
  const req = { user: { role: 'secretary', _id: 'signed-in' }, body: { items: [{ reportId: 'report' }], decision: 'receive', confirmedReceived: true, userId: 'spoofed' } };
  assert.equal((await f.call('post', '/review-batch', req, true)).statusCode, 403);
  assert.equal(f.captures.length, 0);
  req.user.role = 'admin';
  assert.equal((await f.call('post', '/review-batch', req, true)).statusCode, 200);
  assert.equal(f.captures[0].batchReview.userId, 'signed-in');
  assert.equal(f.captures[0].batchReview.confirmedReceived, true);
  assert.equal(fixture(true).routes.some(row => row.url === '/review-batch'), false);
});

test('Review all previews pending reports across pages and refuses silently truncating over 100 reports', async () => {
  const f = fixture(false, undefined, 23);
  const req = { query: { selection: 'all', page: '3', status: 'received' } };
  const res = await f.call('get', '/', req);
  assert.equal(f.captures[0].filter.status, 'pending');
  assert.equal(f.captures[1].skip, 0); assert.equal(f.captures[2].limit, 100);
  assert.equal(res.body.pagination.total, 23);
  const many = fixture(false, undefined, 101);
  assert.equal((await many.call('get', '/', req)).statusCode, 400);
});

test('admin report filtering and Review all use the selected technician profile and legacy login identity', async () => {
  for (const selection of [undefined, 'all']) {
    const f = fixture(false), technicianId = '507f1f77bcf86cd799439011';
    const res = await f.call('get', '/', { query: { technicianId, selection } });
    assert.equal(res.statusCode, 200);
    assert.equal(f.captures[0].technician.$or[0]._id, technicianId);
    assert.deepEqual(Array.from(f.captures[1].filter.technicianId.$in), [technicianId, '507f1f77bcf86cd799439012']);
  }
  for (const technicianId of ['invalid', { $ne: '' }, ['507f1f77bcf86cd799439011']]) {
    const f = fixture(false);
    assert.equal((await f.call('get', '/', { query: { technicianId } })).statusCode, 400);
    assert.equal(f.captures.length, 0);
  }
});
test('receipt mutations are admin only, while technician lists are scoped and paginated', async () => {
  const admin = fixture(false);
  const forbidden = await admin.call('post', '/:id/review', { user: { _id: 'secretary', role: 'secretary' }, params: { id: 'report' }, body: {} }, true);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(admin.captures.length, 0);
  const allowed = await admin.call('post', '/:id/review', { user: { _id: 'actual-admin', role: 'admin' }, params: { id: 'report' }, body: { decision: 'receive', userId: 'spoofed' } }, true);
  assert.equal(allowed.statusCode, 200);
  assert.equal(admin.captures[0].review.userId, 'actual-admin');
  const tech = fixture(true);
  const res = await tech.call('get', '/', { returnContext: { technicianIds: ['mine'] }, query: { page: '2', limit: '1000', technicianId: 'someone-else', status: 'any' } });
  assert.deepEqual(Array.from(tech.captures[0].filter.technicianId.$in), ['mine']);
  assert.equal(tech.captures[0].filter.status, 'pending');
  assert.equal(tech.captures[1].skip, 10);
  assert.equal(tech.captures[2].limit, 10);
  assert.equal(res.body.pagination.limit, 10);
});
test('both pages render a scrollable receipt form and distinguish pending reports from received stock', async () => {
  for (const view of ['pages/technician/tools.ejs', 'pages/admin/Inventory/EquipmentReturns.ejs']) {
    const html = await ejs.renderFile(path.join(__dirname, '../views', view), {});
    assert.match(html, /id="kitReturnsPanel"/);
    assert.match(html, /id="krModal"[^]*?modal-dialog-scrollable[^]*?<form class="modal-content"/);
    assert.match(html, /Awaiting admin receipt/);
    assert.match(html, /I checked the returned items/);
    assert.match(html, /kit-returns\.js\?v=/);
  }
  const technician = await ejs.renderFile(path.join(__dirname, '../views/pages/technician/tools.ejs'), {});
  assert.match(technician, /id="ttReturnUse" required/);
  assert.match(technician, /Admin checks what was received/);
});
test('legacy technician and project return routes submit reports rather than increasing stock', () => {
  const technician = fs.readFileSync(path.join(__dirname, '../routes/technicianApi.js'), 'utf8');
  const material = technician.slice(technician.indexOf('router.post("/daily-kit/return-consumable"'), technician.indexOf('/daily-kit/inventory-search'));
  assert.match(material, /reportMaterials/);
  assert.doesNotMatch(material, /\$inc|quantityReturned\s*\+=/);
  const project = fs.readFileSync(path.join(__dirname, '../routes/projectRoutes.js'), 'utf8');
  const route = project.slice(project.indexOf('router.put("/projects/:id/equipment/return"'), project.indexOf('\n});', project.indexOf('router.put("/projects/:id/equipment/return"')));
  assert.match(route, /reportEquipment/);
  assert.match(route, /technicianId: \{ \$in: technicianIds \}/);
  assert.doesNotMatch(route, /\$exists: true|tool\.quantity\s*=/);
});
test('sidebar counts pending material reports and each overdue or pending equipment record only once', async t => {
  const now = new Date('2026-10-13T03:00:00Z');
  t.mock.method(require('../models/EquipmentAssignment'), 'countDocuments', async filter => {
    assert.equal(filter.consumable.$ne, true);
    const pending = filter.$or.some(clause => clause.returnPending);
    assert.equal(filter.$or.at(-1).$and[1].workDate.$lt.toISOString(), '2026-10-12T16:00:00.000Z');
    return pending ? 4 : 3;
  });
  t.mock.method(require('../models/KitReturn'), 'countDocuments', async filter => {
    assert.deepEqual(filter, { status: 'pending', category: { $in: ['consumable', 'repair_part'] } });
    return 2;
  });
  assert.deepEqual(await require('../utils/inventoryReturnSummary').inventoryReturnSummary(now), { overdue: 3, actionable: 6 });
});
