const Tool = require('../models/Tool');
const { preparationRead } = require('./preparationRead');

const SERVICE_KITS = [
  { match: /repair|inspect|diagnos|troubleshoot|problem|issue/i, equipment: ['tool kit', 'ladder', 'multimeter', 'gauge manifold', 'leak detector', 'thermometer'], consumables: [['gloves', 1], ['cleaning cloth', 1]] },
  { match: /clean|maintenance|tune.?up/i, equipment: ['tool kit', 'ladder', 'pressure sprayer', 'vacuum'], consumables: [['coil cleaner', 1], ['cleaning cloth', 2], ['gloves', 1]] },
  { match: /install/i, equipment: ['tool kit', 'ladder', 'vacuum pump', 'gauge manifold', 'multimeter'], consumables: [['copper', 1], ['electrical tape', 1], ['drain hose', 1]] },
  { match: /check/i, equipment: ['tool kit', 'ladder', 'multimeter', 'gauge manifold', 'leak detector'], consumables: [['gloves', 1], ['cleaning cloth', 1]] },
  { match: /refrigerant|recharge/i, equipment: ['gauge manifold', 'vacuum pump', 'leak detector', 'weighing scale'], consumables: [['refrigerant', 1], ['gloves', 1]] },
];

function available(item) {
  return Math.max(0, Number(item.quantity || 0) - Number(item.reservedQuantity || 0));
}

function scoreMatch(item, wanted) {
  const text = `${item.itemName || ''} ${item.category || ''} ${item.description || ''}`.toLowerCase();
  const words = wanted.toLowerCase().split(/\s+/).filter(Boolean);
  return words.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
}

async function buildLegacyServicePreparation(booking, opts = {}) {
  const inventory = await preparationRead(opts, 'inventory', 'operational', () => Tool.find({
    active: { $ne: false }, status: { $ne: 'discontinued' },
    assetStatus: { $nin: ['under_maintenance', 'damaged', 'retired'] },
  }).select('itemName category description type inventoryClass quantity reservedQuantity unit assignable assetStatus').lean());
  return buildDefaultServicePreparation(booking, inventory, opts);
}

// The admin preview and technician generation share this exact matcher.
// A catalog snapshot lets all service previews use one inventory read.
function buildDefaultServicePreparation(booking, inventory, opts = {}) {
  // preferToolIds: inventory ids already present in the technician's current
  // daily kit. Requirements keep resolving to these "sticky" picks instead of
  // drifting to whatever unit happens to have the most stock right now —
  // otherwise every re-sync manufactures phantom "new requirement" deltas.
  const preferToolIds = opts.preferToolIds instanceof Set ? opts.preferToolIds : null;
  const itemContext = Array.isArray(booking?.services)
    ? booking.services.map(item => `${item?.name || ''} ${item?.repairIssue || ''} ${item?.problemDescription || ''}`).join(' ')
    : '';
  // Keep the broad context for recommendation matching, but never expose it as
  // the modal title. Repair issue text is often snapshotted in several booking
  // fields and previously produced titles such as "Overheating" four times.
  const matchingContext = `${booking?.service?.name || ''} ${booking?.serviceName || ''} ${booking?.serviceType || ''} ${itemContext} ${booking?.issueDescription || ''} ${booking?.unitInfo?.problemDescription || ''}`.trim();
  const serviceLabels = [
    booking?.service?.name,
    ...(Array.isArray(booking?.services) ? booking.services.map(item => item?.name) : []),
  ].map(value => String(value || '').trim()).filter(Boolean);
  const serviceLabel = serviceLabels.find((value, index) => serviceLabels.findIndex(candidate => candidate.toLowerCase() === value.toLowerCase()) === index)
    || (booking?.serviceType === 'repair' ? 'Repair Service' : 'Service');
  const firstService = Array.isArray(booking?.services) ? booking.services[0] : null;
  const unitLabel = String(
    firstService?.applianceTypeName || firstService?.airconTypeName ||
    booking?.unitInfo?.unitType || booking?.applianceTypeName || ''
  ).trim();
  const serviceName = unitLabel && !serviceLabel.toLowerCase().includes(unitLabel.toLowerCase())
    ? `${unitLabel} ${serviceLabel}`
    : serviceLabel;
  // Mixed bookings can match several service families. Combining the catalog
  // requirements here keeps Core and Repair workflows separate while allowing
  // one shared visit kit. No repair-part recommendation is read here.
  const matchedKits = SERVICE_KITS.filter(k => k.match.test(matchingContext));
  const kits = matchedKits.length ? matchedKits : [SERVICE_KITS[0]];
  inventory = inventory.filter(item => item.active !== false && item.status !== 'discontinued'
    && !['under_maintenance', 'damaged', 'retired'].includes(item.assetStatus));

  const pick = (wanted, kind) => {
    const sticky = (item) => (preferToolIds && preferToolIds.has(String(item._id)) ? 1 : 0);
    const candidates = inventory.filter(item => {
      if (kind === 'equipment') return Tool.effectiveInventoryClass(item) === 'operational_asset' && item.type !== 'consumable' && item.assignable !== false;
      return item.type === 'consumable';
    }).map(item => ({ item, score: scoreMatch(item, wanted) })).filter(x => x.score > 0).sort((a, b) =>
      b.score - a.score ||
      sticky(b.item) - sticky(a.item) ||
      available(b.item) - available(a.item) ||
      String(a.item.itemName).localeCompare(String(b.item.itemName))
    );
    return candidates[0]?.item || null;
  };

  const recommendations = [];
  for (const name of [...new Set(kits.flatMap(kit => kit.equipment))]) {
    const item = pick(name, 'equipment');
    if (item && !recommendations.some(r => String(r.inventoryId) === String(item._id))) recommendations.push({ inventoryId: item._id, name: item.itemName, kind: 'equipment', quantity: 1, recommended: true, available: available(item), unit: item.unit || 'pcs' });
    else if (!item) recommendations.push({ inventoryId: null, name, kind: 'equipment', quantity: 1, recommended: true, available: 0, unit: 'pcs', catalogMissing: true });
  }
  const consumableNeeds = new Map();
  for (const [name, qty] of kits.flatMap(kit => kit.consumables)) {
    consumableNeeds.set(name, Math.max(consumableNeeds.get(name) || 0, qty));
  }
  for (const [name, qty] of consumableNeeds) {
    const item = pick(name, 'consumable');
    if (item && !recommendations.some(r => String(r.inventoryId) === String(item._id))) recommendations.push({ inventoryId: item._id, name: item.itemName, kind: 'consumable', quantity: qty, recommended: true, available: available(item), unit: item.unit || 'pcs' });
    else if (!item) recommendations.push({ inventoryId: null, name, kind: 'consumable', quantity: qty, recommended: true, available: 0, unit: 'pcs', catalogMissing: true });
  }

  const catalog = inventory.filter(item => available(item) > 0 && (
    (Tool.effectiveInventoryClass(item) === 'operational_asset' && item.type !== 'consumable' && item.assignable !== false) || item.type === 'consumable'
  )).map(item => ({ inventoryId: item._id, name: item.itemName, kind: item.type === 'consumable' ? 'consumable' : 'equipment', available: available(item), unit: item.unit || 'pcs' }));
  return { serviceName, recommendations, catalog };
}

async function buildServicePreparation(booking, opts = {}) {
  const { rulesForBooking } = require('./serviceKitRules');
  const entries = await rulesForBooking(booking || {}, opts);
  if (!entries.some(entry => entry.rule)) {
    const selected = opts.serviceItemId ? entries[0] : null;
    if (opts.serviceItemId && !selected) return { serviceName: 'Service', recommendations: [], catalog: [] };
    return buildLegacyServicePreparation(selected ? { ...booking, service: { name: selected.item.name },
      serviceName: selected.item.name, serviceType: selected.item.type || 'core', services: [selected.item] } : booking, opts);
  }
  const configuredIds = [...new Set(entries.flatMap(entry => (entry.rule?.[entry.phase] || []).map(row => String(row.toolId))))];
  const tools = configuredIds.length ? await preparationRead(opts, 'configuredTools', [...configuredIds].sort(), () => Tool.find({ _id: { $in: configuredIds } }).lean()) : [];
  const toolMap = new Map(tools.map(tool => [String(tool._id), tool]));
  const recommendations = [];
  for (const entry of entries) {
    if (entry.rule) {
      for (const row of entry.rule[entry.phase] || []) {
        const tool = toolMap.get(String(row.toolId));
        const quantity = Number(row.quantity) * (row.quantityBasis === 'per_unit' ? entry.quantity : 1);
        recommendations.push({ inventoryId: row.toolId, name: tool?.itemName || row.name, kind: row.category,
          unit: tool?.unit || row.unit || 'pcs', quantity, available: tool ? available(tool) : 0,
          recommended: true, catalogMissing: !tool, quantityApplied: true, quantityBasis: 'per_visit',
          ruleQuantityBasis: row.quantityBasis, baseQuantity: Number(row.quantity), serviceId: entry.serviceId,
          serviceModel: entry.serviceModel, ruleRevision: entry.rule.revision,
          serviceGroupIndex: Array.isArray(booking.services) ? booking.services.indexOf(entry.item) : null });
      }
    } else {
      const fallback = await buildLegacyServicePreparation({ ...booking, serviceType: entry.item.type || 'core',
        service: { name: entry.item.name }, serviceName: entry.item.name, services: [entry.item] }, opts);
      for (const row of fallback.recommendations) recommendations.push({ ...row,
        quantity: row.quantity * entry.quantity, quantityApplied: true, quantityBasis: 'per_visit',
        serviceId: entry.serviceId, serviceModel: entry.serviceModel, baseQuantity: row.quantity, ruleQuantityBasis: 'per_unit',
        serviceGroupIndex: Array.isArray(booking.services) ? booking.services.indexOf(entry.item) : null });
    }
  }
  return { serviceName: booking?.service?.name || booking?.serviceName || entries.map(entry => entry.item.name).filter(Boolean).join(', ') || 'Service',
    recommendations, catalog: tools.filter(require('./serviceKitRules').selectable).map(tool => ({
      inventoryId: tool._id, name: tool.itemName, kind: tool.type === 'consumable' ? 'consumable' : 'equipment',
      available: available(tool), unit: tool.unit || 'pcs' })), ruleControlled: true };
}

/**
 * Auto-reserve resources for an accepted booking.
 * Creates EquipmentAssignment records with status 'reserved' and increments
 * tool.reservedQuantity WITHOUT deducting tool.quantity (physical checkout
 * happens later).
 *
 * @param {Object} opts
 * @param {ObjectId} opts.bookingId
 * @param {ObjectId} opts.serviceItemId - optional service item ID
 * @param {String}   opts.bookingReference
 * @param {ObjectId} opts.technicianId
 * @param {Date}     opts.workDate
 * @param {Object}   opts.booking - populated booking document
 * @param {Object}   opts.io - socket.io instance (optional)
 * @returns {{ reserved: Array, issues: Array, preparationStatus: string }}
 */
async function autoReserveResources({ bookingId, serviceItemId, bookingReference, technicianId, workDate, booking, io }) {
  const EquipmentAssignment = require('../models/EquipmentAssignment');
  const StockReservation = require('../models/StockReservation');
  const ToolModel = require('../models/Tool');

  const reserved = [];
  const issues = [];

  // 1. Build service preparation recommendations
  const prep = await buildServicePreparation(booking, { serviceItemId });

  // 2. Reserve recommended equipment and consumables
  for (const rec of prep.recommendations) {
    const tool = await ToolModel.findById(rec.inventoryId);
    if (!tool) { issues.push({ name: rec.name, reason: 'Item not found in inventory' }); continue; }

    const isConsumable = rec.kind === 'consumable';
    const avail = available(tool);

    if (avail < rec.quantity) {
      issues.push({ name: rec.name, reason: `Insufficient stock (need ${rec.quantity}, available ${avail})` });
      continue;
    }

    // Check if this specific tool is already reserved for a conflicting booking on the same date
    const conflictingReservation = await EquipmentAssignment.findOne({
      equipmentId: tool._id,
      workDate: workDate,
      status: { $in: ['reserved', 'checked_out', 'in_use'] },
      bookingId: { $ne: bookingId },
    }).lean();

    if (conflictingReservation) {
      // Check if there's another unit of the same item available
      const allUnits = await ToolModel.find({
        itemName: tool.itemName,
        active: { $ne: false },
        status: { $in: ['in_stock', 'low_stock'] },
        assetStatus: { $nin: ['under_maintenance', 'damaged', 'retired'] },
      }).lean();

      const altUnit = allUnits.find(u => {
        const uAvail = available(u);
        const uConflict = allUnits.length > 0; // any other unit
        return String(u._id) !== String(tool._id) && uAvail >= rec.quantity;
      });

      if (altUnit) {
        // Reserve the alternative unit instead
        const eqAssignment = await EquipmentAssignment.create({
          bookingId, serviceItemId: serviceItemId || null, bookingReference: bookingReference || '',
          technicianId, workDate,
          equipmentId: altUnit._id, equipmentName: altUnit.itemName,
          equipmentCode: altUnit.assetCode || altUnit.barcode || '',
          quantity: rec.quantity,
          consumable: isConsumable, status: 'reserved',
          notes: `Auto-reserved (alternative unit — ${tool.itemName} was conflict-booked)`,
        });
        altUnit.reservedQuantity = Number(altUnit.reservedQuantity || 0) + rec.quantity;
        await altUnit.save();
        reserved.push({ assignmentId: eqAssignment._id, name: altUnit.itemName, kind: rec.kind, quantity: rec.quantity });
      } else {
        issues.push({ name: rec.name, reason: 'All units reserved for conflicting bookings' });
      }
      continue;
    }

    // Create EquipmentAssignment with status 'reserved'
    const eqAssignment = await EquipmentAssignment.create({
      bookingId, serviceItemId: serviceItemId || null, bookingReference: bookingReference || '',
      technicianId, workDate,
      equipmentId: tool._id, equipmentName: tool.itemName,
      equipmentCode: tool.assetCode || tool.barcode || '',
      quantity: rec.quantity,
      consumable: isConsumable, status: 'reserved',
      notes: rec.recommended ? 'Auto-reserved on acceptance (service recommendation)' : 'Auto-reserved on acceptance',
    });

    // Only reserve (don't deduct quantity yet — that happens at checkout)
    tool.reservedQuantity = Number(tool.reservedQuantity || 0) + rec.quantity;
    await tool.save();

    reserved.push({ assignmentId: eqAssignment._id, name: tool.itemName, kind: rec.kind, quantity: rec.quantity });
  }

  // AI-suggested repair parts are deliberately excluded here. Actual parts
  // enter inventory only after on-site inspection, quotation and decision.

  // 3. Store preparation snapshot on booking
  if (reserved.length > 0 || issues.length === 0) {
    booking.servicePreparation = {
      ...(booking.servicePreparation || {}),
      autoReserved: true,
      autoReservedAt: new Date(),
      items: reserved.map(r => ({ name: r.name, kind: r.kind, quantity: r.quantity })),
    };
    await booking.save();
  }

  // 5. Determine preparation status
  let preparationStatus = 'reserved';
  if (issues.length > 0 && reserved.length === 0) {
    preparationStatus = 'issue';
  } else if (issues.length > 0) {
    preparationStatus = 'issue'; // partial reservation still counts as issue
  }

  return { reserved, issues, preparationStatus };
}

module.exports = { buildServicePreparation, buildLegacyServicePreparation, buildDefaultServicePreparation, autoReserveResources };
