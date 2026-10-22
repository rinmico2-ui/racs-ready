'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const { projectRuleResources } = require('../utils/projectServiceKitRules');
const ids = Array.from({ length: 12 }, (_, index) => new mongoose.Types.ObjectId().toString());
const [CORE, CORE2, REPAIR, EQ, SUPPLY, PART, USER, ITEM, OTHERITEM, ORDER] = ids;
const plain = value => JSON.parse(JSON.stringify(value));
function query(value) {
  return { select() { return this; }, sort() { return this; }, lean() { return Promise.resolve(value); } };
}
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    const current = row[key];
    if (value?.$in) return value.$in.some(option => option instanceof RegExp ? option.test(current || '') : String(option) === String(current));
    if (value?.$ne !== undefined) return current !== value.$ne;
    if (value?.$nin) return !value.$nin.includes(current);
    return value === null ? current == null : String(current) === String(value);
  });
}
function load(file, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    module, exports: module.exports, console, Date, Map, Set, RegExp,
    require: name => name in dependencies ? dependencies[name] : require('node:module').createRequire(path.resolve(__dirname, file))(name),
  }, { filename: file });
  return module.exports;
}
function fixture() {
  const core = [{ _id: CORE, name: 'Aircon Installation', slug: 'aircon-installation', active: true }, { _id: CORE2, name: 'Coil (deep) cleaning', active: false }];
  const repair = [{ _id: REPAIR, name: 'Aircon Installation', active: true }];
  const categories = [];
  const tools = [{ _id: EQ, itemName: 'Field Kit', type: 'equipment', inventoryClass: 'operational_asset', quantity: 3 },
    { _id: SUPPLY, itemName: 'Tape', type: 'consumable', quantity: 0 }, { _id: PART, itemName: 'Motor', type: 'part', quantity: 12 }];
  const rules = [];
  const reads = [];
  const base = rows => ({ find: filter => { reads.push(rows); return query(rows.filter(row => matches(row, filter))); }, findById: id => query(rows.find(row => String(row._id) === String(id))) });
  const Core = base(core), Repair = base(repair), Categories = base(categories), Tools = { ...base(tools), effectiveInventoryClass: tool => tool.inventoryClass || 'operational_asset' };
  let indexCalls = 0;
  const Rules = { ...base(rules), collection: { async createIndex() { indexCalls++; } },
    findOneAndUpdate(filter, update, options) {
      return { async lean() {
        let row = rules.find(row => matches(row, filter));
        if (!row) {
          if (!options.upsert) return null;
          if (rules.some(row => row.serviceModel === filter.serviceModel && row.serviceId === filter.serviceId)) throw Object.assign(new Error('duplicate'), { code: 11000 });
          row = { ...filter, ...update.$setOnInsert, history: [] }; rules.push(row);
        }
        Object.assign(row, plain(update.$set)); row.revision += update.$inc.revision;
        row.history.push(...plain(update.$push.history.$each)); row.history = row.history.slice(-20);
        return plain(row);
      } };
    },
  };
  const deps = { mongoose, '../models/ServiceKitRule': Rules, '../models/CoreService': Core, '../models/RepairService': Repair, '../models/ServiceCategory': Categories, '../models/Tool': Tools };
  const api = load('../utils/serviceKitRules.js', deps);
  const service = api.createService({ Rules, Core, Repair, Categories, Tools });
  const preparation = load('../utils/servicePreparation.js', { '../models/Tool': Tools, './serviceKitRules': api });
  deps['./servicePreparation'] = preparation;
  const orderApi = load('../utils/orderPreparation.js', { mongoose, './servicePreparation': preparation, './bookingDateTime': require('../utils/bookingDateTime') });
  const save = (payload, serviceModel = 'CoreService', serviceId = CORE) => service.save({ serviceModel, serviceId, payload, userId: USER });
  const item = (toolId = EQ, quantity = 1, quantityBasis = 'per_visit') => ({ toolId, quantity, quantityBasis });
  return { core, repair, categories, tools, rules, reads, api, service, preparation, orderApi, save, item, indexCalls: () => indexCalls };
}
test('every core and repair service is listed, including inactive services and zero-stock consumables', async () => {
  const f = fixture(), result = await f.service.list();
  assert.equal(result.services.length, 3);
  assert.equal(result.services.find(service => service.id === CORE2).active, false);
  assert.equal(result.services.filter(service => service.name === 'Aircon Installation').length, 2);
  assert.equal(result.catalog.length, 2);
  assert.equal(result.catalog.find(tool => tool.id === SUPPLY).available, 0);
});

test('multiple jobs reuse planning reads while a new operation sees current inventory', async () => {
  const f = fixture(), options = { readCache: new Map() };
  const booking = { serviceType: 'core', service: { name: 'Aircon Installation' } };
  const results = await Promise.all([f.preparation.buildServicePreparation(booking, options), f.preparation.buildServicePreparation(booking, options)]);
  assert.deepEqual(plain(results[0]), plain(results[1]));
  for (const rows of [f.core, f.rules, f.tools]) assert.equal(f.reads.filter(read => read === rows).length, 1);
  f.tools[0].quantity = 1;
  const fresh = await f.preparation.buildServicePreparation(booking, { readCache: new Map() });
  assert.equal(f.reads.filter(read => read === f.tools).length, 2);
  assert.equal(fresh.catalog.find(row => row.inventoryId === EQ).available, 1);
});
test('admin defaults use the same inventory choices and base quantities as technician generation', async () => {
  const f = fixture(); f.tools[0].itemName = 'Tool Kit';
  f.tools.push({ _id: ids[10], itemName: 'Copper Tube', type: 'consumable', quantity: 5, reservedQuantity: 2, unit: 'm' });
  const result = await f.service.list();
  const preview = result.services.find(service => service.id === CORE).defaults.items;
  const generated = await f.preparation.buildLegacyServicePreparation({ serviceType: 'core', service: { name: 'Aircon Installation' }, services: [{ name: 'Aircon Installation', type: 'core', quantity: 1 }] });
  assert.deepEqual(plain(preview.map(row => ({ toolId: row.toolId, name: row.name, quantity: row.quantity, available: row.available }))),
    plain(generated.recommendations.map(row => ({ toolId: row.inventoryId || null, name: row.name, quantity: row.quantity, available: row.available }))));
  assert.ok(preview.some(row => row.catalogMissing && !row.toolId));
  assert.equal(preview.find(row => row.toolId === ids[10]).available, 3);
  assert.equal(f.indexCalls(), 0); assert.equal(f.rules.length, 0);
});
test('defaults remain visible for custom rules and both repair visit lists without changing saved rules', async () => {
  const f = fixture(); f.categories.push({ _id: ids[11], slug: 'aircon', name: 'Air Conditioner' });
  await f.save({ revision: 0, mode: 'custom', inspectionItems: [f.item(EQ)], repairItems: [f.item(SUPPLY)] }, 'ServiceCategory', ids[11]);
  const before = plain(f.rules); const result = await f.service.list();
  const service = result.services.find(service => service.serviceModel === 'ServiceCategory');
  assert.ok(service.defaults.inspectionItems.length); assert.ok(service.defaults.repairItems.length);
  assert.equal(service.rule.repairItems[0].toolId, SUPPLY); assert.deepEqual(plain(f.rules), before);
});
test('actual customer repair categories are editable and drive both visits from the saved category slug', async () => {
  const f = fixture(); f.categories.push({ _id: ids[11], slug: 'aircon', name: 'Air Conditioner', unitTypes: [{ value: 'split', label: 'Split Type' }] });
  await f.save({ revision: 0, mode: 'custom', inspectionItems: [f.item(EQ)], repairItems: [f.item(SUPPLY, 2, 'per_unit')] }, 'ServiceCategory', ids[11]);
  const listed = await f.service.list(); assert.equal(listed.services.find(service => service.id === ids[11]).serviceModel, 'ServiceCategory');
  const booking = { serviceType: 'repair', services: [{ name: 'Carrier split', type: 'repair', unitCategory: 'aircon', unitType: 'split', quantity: 3, phase: 'repair_phase_1' }] };
  const inspection = await f.preparation.buildServicePreparation(booking); assert.equal(inspection.recommendations[0].inventoryId, EQ);
  booking.services[0].phase = 'repair_phase_2';
  const repair = await f.preparation.buildServicePreparation(booking); assert.equal(repair.recommendations[0].inventoryId, SUPPLY); assert.equal(repair.recommendations[0].quantity, 6);
});
test('older customer repairs resolve an exact unique unit type, while unknown category hints never select another category', async () => {
  const f = fixture(); f.categories.push({ _id: ids[11], slug: 'aircon', name: 'Air Conditioner', unitTypes: [{ value: 'split', label: 'Split Type' }] });
  await f.save({ revision: 0, mode: 'custom', inspectionItems: [f.item(EQ)], repairItems: [f.item(EQ)] }, 'ServiceCategory', ids[11]);
  let result = await f.api.rulesForBooking({ serviceType: 'repair', unitInfo: { unitType: 'Split Type' } }); assert.equal(result[0].serviceModel, 'ServiceCategory'); assert.ok(result[0].rule);
  result = await f.api.rulesForBooking({ services: [{ type: 'repair', unitType: 'split', unitCategory: 'unknown_category' }] }); assert.equal(result[0].rule, null);
});
test('a customer repair assignment in a mixed booking never inherits the parent core service ID', async () => {
  const f = fixture(); f.categories.push({ _id: ids[11], slug: 'aircon', name: 'Air Conditioner' });
  await f.save({ revision: 0, mode: 'custom', inspectionItems: [f.item(SUPPLY)], repairItems: [f.item(EQ)] }, 'ServiceCategory', ids[11]);
  const result = await f.preparation.buildServicePreparation({ serviceId: CORE, serviceType: 'mixed', services: [
    { _id: OTHERITEM, serviceId: CORE, name: 'Aircon Installation', type: 'core' },
    { _id: ITEM, name: 'Carrier split', type: 'repair', unitCategory: 'aircon', phase: 'repair_phase_1' },
  ] }, { serviceItemId: ITEM });
  assert.equal(result.recommendations.length, 1); assert.equal(result.recommendations[0].inventoryId, SUPPLY); assert.equal(result.recommendations[0].serviceModel, 'ServiceCategory');
});
test('saved rule uses exact catalog identity and server-owned names, units and categories', async () => {
  const f = fixture();
  const saved = await f.save({ revision: 0, mode: 'custom', items: [{ ...f.item(), name: 'Forged', category: 'part', unit: 'wrong' }] });
  assert.equal(saved.items[0].name, 'Field Kit'); assert.equal(saved.items[0].category, 'equipment'); assert.equal(saved.items[0].unit, 'pcs');
  assert.equal(saved.revision, 1); assert.equal(f.indexCalls(), 1); assert.equal(f.rules[0].history[0].updatedBy, USER);
});
test('core and repair rules with the same service name remain separate', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', items: [f.item()] });
  await f.save({ revision: 0, mode: 'custom', inspectionItems: [f.item(SUPPLY, 2, 'per_unit')], repairItems: [f.item(EQ, 3)] }, 'RepairService', REPAIR);
  const core = await f.preparation.buildServicePreparation({ services: [{ serviceId: CORE, name: 'Aircon Installation', type: 'core', quantity: 5 }] });
  const inspection = await f.preparation.buildServicePreparation({ services: [{ serviceId: REPAIR, name: 'Aircon Installation', type: 'repair', quantity: 5, phase: 'repair_phase_1' }] });
  const repair = await f.preparation.buildServicePreparation({ services: [{ serviceId: REPAIR, type: 'repair', quantity: 5, phase: 'repair_phase_2' }] });
  assert.equal(core.recommendations[0].quantity, 1); assert.equal(inspection.recommendations[0].quantity, 10); assert.equal(repair.recommendations[0].quantity, 3);
  assert.equal(repair.recommendations[0].inventoryId, EQ);
});
test('flat legacy repair booking and single-item parent repair status use the repair visit list', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', inspectionItems: [f.item(EQ)], repairItems: [f.item(SUPPLY, 4)] }, 'RepairService', REPAIR);
  for (const booking of [{ serviceId: REPAIR, serviceType: 'repair', phase: 'repair_phase_2' },
    { serviceType: 'repair', status: 'repair_scheduled', services: [{ serviceId: REPAIR, type: 'repair', status: 'pending' }] }]) {
    const result = await f.preparation.buildServicePreparation(booking); assert.equal(result.recommendations[0].inventoryId, SUPPLY);
  }
});
test('assignment kit isolates its service item and applies its assigned unit count once', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', items: [f.item(SUPPLY, 2, 'per_unit')] });
  const result = await f.preparation.buildServicePreparation({ services: [{ _id: ITEM, serviceId: CORE, name: 'Aircon Installation', type: 'core', quantity: 5 }, { _id: OTHERITEM, serviceId: CORE2, name: 'cleaning', type: 'core' }] }, { serviceItemId: ITEM, quantity: 2 });
  assert.equal(result.recommendations.length, 1); assert.equal(result.recommendations[0].quantity, 4); assert.equal(result.recommendations[0].quantityApplied, true);
});
test('an inspection item in a mixed booking keeps its inspection kit when another item is in repair', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', inspectionItems: [f.item(EQ)], repairItems: [f.item(SUPPLY, 4)] }, 'RepairService', REPAIR);
  const result = await f.preparation.buildServicePreparation({ serviceType: 'mixed', status: 'repair_scheduled', services: [
    { _id: ITEM, serviceId: REPAIR, type: 'repair', phase: 'repair_phase_1' }, { _id: OTHERITEM, serviceId: REPAIR, type: 'repair', phase: 'repair_phase_2' },
  ] }, { serviceItemId: ITEM });
  assert.equal(result.recommendations[0].inventoryId, EQ);
});
test('exact-name fallback escapes punctuation and refuses ambiguous legacy names', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', items: [f.item()] }, 'CoreService', CORE2);
  let result = await f.api.rulesForBooking({ services: [{ name: 'Coil (deep) cleaning', type: 'core' }] }); assert.equal(result[0].rule.revision, 1);
  f.core.push({ _id: ids[11], name: 'Coil (deep) cleaning' });
  result = await f.api.rulesForBooking({ services: [{ name: 'Coil (deep) cleaning', type: 'core' }] }); assert.equal(result[0].rule, null);
});
test('a booking with an unknown saved service ID never picks a different service by name', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', items: [f.item()] });
  const result = await f.api.rulesForBooking({ services: [{ serviceId: ids[10], name: 'Aircon Installation', type: 'core' }] }); assert.equal(result[0].rule, null);
});
test('inactive or deleted configured items stay explicit; another tool with the same name is never substituted', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', items: [f.item()] });
  f.tools.splice(0, 1); f.tools.push({ _id: ids[10], itemName: 'Field Kit', type: 'equipment', quantity: 99 });
  const result = await f.preparation.buildServicePreparation({ serviceId: CORE, serviceType: 'core' });
  assert.equal(result.recommendations[0].inventoryId, EQ); assert.equal(result.recommendations[0].catalogMissing, true); assert.equal(result.recommendations[0].available, 0);
});
test('delivery installation uses the installation service rule for all order aircons', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', items: [f.item(EQ), f.item(SUPPLY, 2, 'per_unit')] });
  const result = await f.orderApi.buildOrderInstallationPreparation({ fulfillmentType: 'delivery_installation', items: [{ quantity: 2, brand: 'Carrier' }, { quantity: 3, brand: 'Midea' }] });
  assert.equal(result.ruleControlled, true); assert.equal(result.recommendations.filter(row => row.kind === 'consumable').reduce((sum, row) => sum + row.quantity, 0), 10);
  assert.deepEqual(plain(await f.orderApi.buildOrderInstallationPreparation({ fulfillmentType: 'pickup' })), { serviceName: 'Delivery', recommendations: [], catalog: [] });
});
test('per-visit order consumables apply once even when the order has several product lines', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', items: [f.item(SUPPLY, 2, 'per_visit')] });
  const result = await f.orderApi.buildOrderInstallationPreparation({ fulfillmentType: 'delivery_installation', items: [{ quantity: 2 }, { quantity: 3 }] });
  assert.equal(result.recommendations.length, 1); assert.equal(result.recommendations[0].quantity, 2);
});
test('stale admin updates and concurrent first saves return conflict instead of overwriting', async () => {
  const f = fixture(), payload = { revision: 0, mode: 'custom', items: [f.item()] };
  const results = await Promise.allSettled([f.save(payload), f.save(payload)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await f.save({ ...payload, revision: 1, items: [f.item(EQ, 2)] });
  await assert.rejects(f.save({ ...payload, revision: 1 }), error => error.status === 409); assert.equal(f.rules[0].items[0].quantity, 2);
});
test('reset retains revision history and returns to defaults for generation', async () => {
  const f = fixture(); await f.save({ revision: 0, mode: 'custom', items: [f.item()] });
  const result = await f.save({ revision: 1, mode: 'defaults' }); assert.equal(result.revision, 2); assert.equal(result.mode, 'defaults'); assert.equal(f.rules[0].history.length, 2);
  const matched = await f.api.rulesForBooking({ serviceId: CORE }); assert.equal(matched[0].rule, null);
});
test('edit history is bounded while recording every current revision and actor', async () => {
  const f = fixture(); for (let revision = 0; revision < 24; revision++) await f.save({ revision, mode: 'custom', items: [f.item()] });
  assert.equal(f.rules[0].history.length, 20); assert.equal(f.rules[0].history.at(-1).revision, 24); assert.equal(f.rules[0].updatedBy, USER);
});
for (const [label, rows] of [ ['duplicate item', f => [f.item(), f.item()]], ['repair part', f => [f.item(PART)]],
  ['fractional equipment', f => [f.item(EQ, 1.5)]], ['zero quantity', f => [f.item(EQ, 0)]], ['invalid basis', f => [f.item(EQ, 1, 'bad')]],
  ['missing catalog ID', f => [f.item(ids[10])]], ['too many items', f => Array(51).fill(f.item())] ]) {
  test(`saving rejects ${label}`, async () => { const f = fixture(); await assert.rejects(f.save({ revision: 0, mode: 'custom', items: rows(f) }), error => error.status === 400); assert.equal(f.rules.length, 0); });
}
test('saving rejects retired equipment and archived services', async () => {
  const f = fixture(); f.tools[0].assetStatus = 'retired'; await assert.rejects(f.save({ revision: 0, mode: 'custom', items: [f.item()] }), error => error.status === 400);
  f.core[0].archivedAt = new Date(); await assert.rejects(f.save({ revision: 0, mode: 'defaults' }), error => error.status === 404);
});
test('empty lists require explicit confirmation for EACH repair visit', async () => {
  const f = fixture(); const payload = { revision: 0, mode: 'custom', inspectionItems: [], repairItems: [], emptyAllowed: { inspectionItems: true } };
  await assert.rejects(f.save(payload, 'RepairService', REPAIR), error => error.status === 400);
  payload.emptyAllowed.repairItems = true; await f.save(payload, 'RepairService', REPAIR);
  const result = await f.preparation.buildServicePreparation({ serviceId: REPAIR, serviceType: 'repair' }); assert.equal(result.recommendations.length, 0); assert.equal(result.ruleControlled, true);
});
test('model enforces exact service uniqueness and persists safe rule snapshots without passwords', () => {
  const Rule = require('../models/ServiceKitRule');
  assert.ok(Rule.schema.indexes().some(([keys, options]) => keys.serviceModel === 1 && keys.serviceId === 1 && options.unique));
  const rule = new Rule({ serviceModel: 'CoreService', serviceId: CORE, updatedBy: USER, items: [{ toolId: EQ, name: 'Kit', category: 'equipment', quantity: 1, quantityBasis: 'per_visit' }] });
  assert.equal(rule.validateSync(), undefined); assert.equal(rule.revision, 1);
});
test('customer, technician and secretary cannot change rules, and validation errors keep their HTTP status', async () => {
  let calls = 0; const controller = require('../controllers/serviceKitRulesController').createController({ save: async () => { calls++; throw Object.assign(new Error('stale'), { status: 409 }); } });
  for (const role of ['customer', 'technician', 'secretary', 'admin']) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller.save({ user: { role, _id: USER }, params: {}, body: {} }, res, error => { throw error; });
    assert.equal(res.statusCode, role === 'admin' ? 409 : 403);
  }
  assert.equal(calls, 1);
});
test('project service lists apply only to their work orders and never multiply consumables twice', () => {
  const preparation = { recommendations: [{ inventoryId: SUPPLY, name: 'Tape', kind: 'consumable', baseQuantity: 2, quantity: 10, ruleQuantityBasis: 'per_unit', serviceId: CORE, serviceModel: 'CoreService', serviceGroupIndex: 0 }] };
  const workOrders = [{ _id: ITEM, units: Array.from({ length: 2 }, () => ({ serviceId: CORE, serviceType: 'core', groupIndex: 0 })) }, { _id: OTHERITEM, units: [{ serviceId: CORE2, groupIndex: 1 }] }];
  const result = projectRuleResources(preparation, workOrders, 3); assert.equal(result.length, 1); assert.equal(result[0].quantity, 4); assert.deepEqual(result[0].affectedWorkOrderIds, [ITEM]); assert.equal(result[0].requirementRule, 'fixed');
});
test('project rules ask for correct work-order details rather than assigning another service’s kit', () => {
  assert.throws(() => projectRuleResources({ recommendations: [{ name: 'Tool', quantity: 1, kind: 'equipment', serviceId: CORE, serviceModel: 'CoreService' }] }, [{ _id: ITEM, units: [] }], 2), /work orders/);
});
test('explicit empty installation rules allow confirmed departure; an unlinked empty kit still blocks', () => {
  const f = fixture(); const order = { _id: ORDER, fulfillmentType: 'delivery_installation', technicianId: USER };
  const kit = { status: 'confirmed', technicianId: USER, items: [], deltaItems: [], noItemsOrderIds: [ORDER] };
  assert.equal(f.orderApi.orderInstallationReadiness(order, kit).status, 'confirmed');
  assert.equal(f.orderApi.orderInstallationReadiness(order, { ...kit, noItemsOrderIds: [] }).status, 'pending');
});
test('daily quantity merging shares reusable equipment but sums consumables without rescaling', () => {
  const source = fs.readFileSync(path.join(__dirname, '../utils/dailyKitService.js'), 'utf8');
  const body = source.slice(source.indexOf('function mergeRequirement('), source.indexOf('const REPAIR_PART_STATUSES'));
  const api = {}; vm.runInNewContext(`${body}\napi.merge = mergeRequirement;`, { api, Map, String, Number, Math, Boolean });
  const rows = new Map(); for (const quantity of [4, 6]) {
    api.merge(rows, { name: 'Tape', kind: 'consumable', inventoryId: SUPPLY, quantity, quantityApplied: true, ruleRevision: 2 }, { multiplier: 5 });
    api.merge(rows, { name: 'Kit', kind: 'equipment', inventoryId: EQ, quantity: 1, quantityApplied: true, ruleRevision: 2 }, { multiplier: 5 });
  }
  assert.equal([...rows.values()].find(row => row.category === 'consumable').quantity, 10); assert.equal([...rows.values()].find(row => row.category === 'equipment').quantity, 1);
  assert.ok([...rows.values()].every(row => row.catalogLocked));
});
