'use strict';

const mongoose = require('mongoose');
const Rule = require('../models/ServiceKitRule');
const CoreService = require('../models/CoreService');
const RepairService = require('../models/RepairService');
const ServiceCategory = require('../models/ServiceCategory');
const Tool = require('../models/Tool');
const ref = value => String(value?._id || value || '');
const problem = (message, status = 400) => Object.assign(new Error(message), { status });

function selectable(tool) {
  return tool && tool.active !== false && !tool.archivedAt && tool.status !== 'discontinued'
    && (tool.type === 'consumable' || (['tool', 'equipment'].includes(tool.type)
      && Tool.effectiveInventoryClass(tool) === 'operational_asset' && tool.assignable !== false
      && !['under_maintenance', 'damaged', 'retired'].includes(tool.assetStatus)));
}
function catalogItem(tool) {
  return { id: ref(tool), name: tool.itemName, category: tool.type === 'consumable' ? 'consumable' : 'equipment',
    unit: tool.unit || 'pcs', available: Math.max(0, Number(tool.quantity || 0) - Number(tool.reservedQuantity || 0)),
    code: tool.assetCode || tool.barcode || '' };
}
function ruleDto(rule) {
  if (!rule) return { mode: 'defaults', revision: 0, items: [], inspectionItems: [], repairItems: [], updatedAt: null };
  return { mode: rule.mode, revision: rule.revision, items: rule.items || [], inspectionItems: rule.inspectionItems || [],
    repairItems: rule.repairItems || [], updatedAt: rule.updatedAt, updatedBy: ref(rule.updatedBy) };
}
function normalizeItems(items, catalog) {
  if (!Array.isArray(items) || items.length > 50) throw problem('Each visit list can contain up to 50 items.');
  const seen = new Set();
  return items.map(row => {
    const id = ref(row?.toolId), tool = catalog.get(id), quantity = Number(row?.quantity);
    if (!mongoose.isValidObjectId(id) || !selectable(tool)) throw problem('Choose active company equipment or a consumable from the catalog. Repair parts come from the approved quotation.');
    if (seen.has(id)) throw problem('An item can appear only once in each visit list. Change its quantity instead.');
    seen.add(id);
    if (!['number', 'string'].includes(typeof row.quantity) || !Number.isFinite(quantity) || quantity < 1 || quantity > 10000
      || (tool.type !== 'consumable' && !Number.isInteger(quantity))) throw problem('Enter a quantity from 1 to 10,000. Equipment quantities must be whole numbers.');
    if (!['per_visit', 'per_unit'].includes(row.quantityBasis)) throw problem('Choose whether the quantity applies per visit or per aircon/unit.');
    return { toolId: tool._id, name: tool.itemName, category: tool.type === 'consumable' ? 'consumable' : 'equipment',
      unit: tool.unit || 'pcs', quantity, quantityBasis: row.quantityBasis };
  });
}

function createService({ Rules = Rule, Core = CoreService, Repair = RepairService, Categories = ServiceCategory, Tools = Tool } = {}) {
  let indexPromise;
  async function list() {
    const [core, repair, categories, rules, tools] = await Promise.all([
      Core.find({ archivedAt: null }).select('name slug category active').sort({ name: 1 }).lean(),
      Repair.find({}).select('name slug applianceType active').sort({ name: 1 }).lean(),
      Categories.find({ archivedAt: null }).select('name slug active').sort({ name: 1 }).lean(),
      Rules.find({}).select('-history').lean(),
      Tools.find({ active: { $ne: false }, archivedAt: null, status: { $ne: 'discontinued' } })
        .select('itemName category description type inventoryClass assignable assetStatus quantity reservedQuantity unit assetCode barcode active status').sort({ itemName: 1 }).lean(),
    ]);
    const mapped = new Map(rules.map(rule => [`${rule.serviceModel}:${ref(rule.serviceId)}`, rule]));
    const { buildDefaultServicePreparation } = require('./servicePreparation');
    const preview = service => {
      const type = service.serviceModel === 'CoreService' ? 'core' : 'repair';
      const { recommendations } = buildDefaultServicePreparation({ serviceType: type,
        service: { name: service.name }, services: [{ name: service.name, type, quantity: 1 }] }, tools);
      const rows = recommendations.map(row => ({ toolId: row.inventoryId ? ref(row.inventoryId) : null,
        name: row.name, category: row.kind, quantity: row.quantity, unit: row.unit,
        available: row.available, catalogMissing: Boolean(row.catalogMissing),
        code: tools.find(tool => ref(tool) === ref(row.inventoryId))?.assetCode || '' }));
      return type === 'core' ? { items: rows, inspectionItems: [], repairItems: [] }
        : { items: [], inspectionItems: rows, repairItems: rows };
    };
    const services = [...core.map(service => ({ ...service, serviceModel: 'CoreService' })),
      ...repair.map(service => ({ ...service, serviceModel: 'RepairService' })),
      ...categories.map(service => ({ ...service, serviceModel: 'ServiceCategory' }))].map(service => ({
      id: ref(service), serviceModel: service.serviceModel, name: service.name, slug: service.slug,
      category: service.category || service.applianceType || '', active: service.active !== false,
      rule: ruleDto(mapped.get(`${service.serviceModel}:${ref(service)}`)),
      defaults: preview(service),
    }));
    return { services, catalog: tools.filter(selectable).map(catalogItem) };
  }
  async function save({ serviceModel, serviceId, payload, userId }) {
    if (!['CoreService', 'RepairService', 'ServiceCategory'].includes(serviceModel) || !mongoose.isValidObjectId(serviceId)) throw problem('Choose a valid service.');
    const Model = serviceModel === 'CoreService' ? Core : serviceModel === 'ServiceCategory' ? Categories : Repair;
    const service = await Model.findById(serviceId).select('name archivedAt').lean();
    if (!service || service.archivedAt) throw problem('This service is no longer available.', 404);
    if (!Number.isInteger(payload?.revision) || payload.revision < 0 || !['custom', 'defaults'].includes(payload?.mode)) throw problem('Refresh the service rules before saving.');
    const fields = serviceModel === 'CoreService' ? ['items'] : ['inspectionItems', 'repairItems'];
    const ids = fields.flatMap(field => Array.isArray(payload[field]) ? payload[field].map(row => ref(row?.toolId)) : []);
    if (ids.some(id => !mongoose.isValidObjectId(id))) throw problem('Select catalog items using the item search.');
    const tools = ids.length ? await Tools.find({ _id: { $in: ids } }).lean() : [];
    const catalog = new Map(tools.map(tool => [ref(tool), tool]));
    const content = { mode: payload.mode, items: [], inspectionItems: [], repairItems: [] };
    if (payload.mode === 'custom') for (const field of fields) {
      content[field] = normalizeItems(payload[field], catalog);
      if (!content[field].length && payload.emptyAllowed?.[field] !== true) throw problem('Confirm that no tools or consumables are required for each empty visit list.');
    }
    // Explicitly ensure uniqueness even where deployment disables autoIndex.
    if (!indexPromise) indexPromise = Rules.collection.createIndex({ serviceModel: 1, serviceId: 1 }, { unique: true }).catch(error => { indexPromise = null; throw error; });
    await indexPromise;
    const now = new Date(), revision = payload.revision + 1;
    const snapshot = { ...content, revision, updatedBy: userId, updatedAt: now };
    try {
      const saved = await Rules.findOneAndUpdate({ serviceModel, serviceId, revision: payload.revision }, {
        $set: { ...content, updatedBy: userId, updatedAt: now }, $inc: { revision: 1 },
        $setOnInsert: { serviceModel, serviceId, createdAt: now },
        $push: { history: { $each: [snapshot], $slice: -20 } },
      }, { upsert: payload.revision === 0, new: true, runValidators: true, setDefaultsOnInsert: false }).lean();
      if (!saved) throw problem('Another staff member changed this rule. Reload the rules before saving again.', 409);
      return ruleDto(saved);
    } catch (error) {
      if (error.code === 11000) throw problem('Another staff member changed this rule. Reload the rules before saving again.', 409);
      throw error;
    }
  }
  return { list, save };
}

// Resolve by saved service identity. Exact-name fallback only supports older
// bookings without IDs; ambiguous names never select an arbitrary rule.
async function rulesForBooking(booking, opts = {}) {
  const { preparationRead } = require('./preparationRead');
  const singleBooking = !Array.isArray(booking.services) || booking.services.length <= 1;
  let entries = Array.isArray(booking.services) && booking.services.length ? booking.services
    : [{ serviceId: booking.serviceId || booking.service?._id, name: booking.service?.name || booking.serviceName,
      type: booking.serviceType === 'repair' || booking.serviceModel === 'RepairService' ? 'repair' : 'core',
      phase: booking.phase, schedule: booking.schedule, status: booking.status, quantity: booking.quantity || 1,
      unitCategory: booking.unitCategory || booking.unitInfo?.unitCategory, unitType: booking.unitInfo?.unitType || booking.applianceTypeName }];
  if (opts.serviceItemId) entries = entries.filter(item => ref(item) === ref(opts.serviceItemId));
  entries = entries.filter(item => !['cancelled', 'completed', 'repair_declined'].includes(item.status));
  const missing = entries.filter(item => !item.serviceId && !(singleBooking && booking.serviceId));
  const queryFor = model => {
    const rows = missing.filter(item => ((item.type || booking.serviceType) === 'repair' ? 'RepairService' : 'CoreService') === model);
    if (!rows.length) return null;
    const slug = opts.serviceSlug || booking.serviceSlug;
    return slug ? { slug } : { name: { $in: rows.map(item => new RegExp('^' + String(item.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')) } };
  };
  const coreQuery = queryFor('CoreService'), repairQuery = queryFor('RepairService');
  const [cores, repairs, categories] = await Promise.all([
    coreQuery ? preparationRead(opts, 'coreCatalog', coreQuery, () => CoreService.find(coreQuery).select('name slug').lean()) : [],
    repairQuery ? preparationRead(opts, 'repairCatalog', repairQuery, () => RepairService.find(repairQuery).select('name slug').lean()) : [],
    missing.some(item => (item.type || booking.serviceType) === 'repair')
      ? preparationRead(opts, 'repairCategories', 'active', () => ServiceCategory.find({ archivedAt: null }).select('name slug unitTypes').lean()) : [],
  ]);
  const resolved = entries.map(item => {
    let serviceModel = (item.type || booking.serviceType) === 'repair' ? 'RepairService' : 'CoreService';
    const catalog = serviceModel === 'RepairService' ? repairs : cores;
    let id = item.serviceId || (singleBooking ? booking.serviceId : null);
    if (!id && serviceModel === 'RepairService') {
      const hint = String(item.unitCategory || '').trim().toLowerCase();
      const unitType = String(item.unitType || item.applianceTypeName || '').trim().toLowerCase();
      const candidates = categories.filter(category => hint ? [category.slug, category.name].some(value => String(value).toLowerCase() === hint)
        : unitType && (category.unitTypes || []).some(unit => [unit.value, unit.label].some(value => String(value).toLowerCase() === unitType)));
      if (hint || candidates.length) {
        serviceModel = 'ServiceCategory';
        if (candidates.length === 1) id = candidates[0]._id;
      }
    }
    if (!id && serviceModel !== 'ServiceCategory') {
      const slug = opts.serviceSlug || booking.serviceSlug;
      const candidates = catalog.filter(service => slug ? service.slug === slug : String(service.name).toLowerCase() === String(item.name || '').toLowerCase());
      if (candidates.length === 1) id = candidates[0]._id;
    }
    const explicitInspection = item.phase === 'repair_phase_1' || item.schedule?.kind === 'inspection';
    const repairVisit = item.phase === 'repair_phase_2' || item.schedule?.kind === 'repair'
      || ['repair_scheduled', 'repair_in_progress', 'ready_for_repair', 'parts_reserved', 'repair_approved'].includes(item.status)
      || ((!booking.services?.length || booking.services.length === 1) && ['repair_scheduled', 'repair_in_progress', 'ready_for_repair', 'parts_reserved', 'repair_approved'].includes(booking.status));
    const rulePhase = !explicitInspection && repairVisit ? 'repairItems' : 'inspectionItems';
    return { item, serviceModel, serviceId: id, phase: serviceModel === 'CoreService' ? 'items' : rulePhase,
      quantity: Math.max(1, Number(opts.serviceItemId ? opts.quantity || item.quantity : item.quantity) || 1) };
  });
  const ids = resolved.map(row => row.serviceId).filter(id => mongoose.isValidObjectId(id));
  const rules = ids.length ? await preparationRead(opts, 'kitRules', ids.map(String).sort(), () => Rule.find({ serviceId: { $in: ids }, mode: 'custom' }).lean()) : [];
  const map = new Map(rules.map(rule => [`${rule.serviceModel}:${ref(rule.serviceId)}`, rule]));
  return resolved.map(row => ({ ...row, rule: map.get(`${row.serviceModel}:${ref(row.serviceId)}`) || null }));
}

module.exports = { createService, rulesForBooking, normalizeItems, selectable, catalogItem, ruleDto };
