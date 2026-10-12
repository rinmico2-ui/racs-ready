'use strict';
const ref = value => String(value?._id || value || '');

// New resource suggestions use the service rules. Confirmed project plans
// remain snapshots; changing a rule never silently edits issued resources.
function projectRuleResources(preparation, workOrders, crew) {
  const rows = [];
  for (const item of preparation.recommendations || []) {
    const matches = workOrders.map(order => {
      const units = (order.units || []).filter(unit => {
        if (unit.status === 'cancelled') return false;
        if (Number.isInteger(item.serviceGroupIndex) && unit.groupIndex !== undefined) {
          if (unit.groupIndex !== item.serviceGroupIndex) return false;
          // Customer repair categories have no priced service ID on work-order units.
          if (item.serviceModel === 'ServiceCategory') return unit.serviceType === 'repair';
        }
        if (!item.serviceId) return false;
        return ref(unit.serviceId) === ref(item.serviceId)
          && (unit.serviceType === 'repair' ? 'RepairService' : 'CoreService') === item.serviceModel;
      });
      return { order, units: units.length };
    }).filter(row => row.units > 0);
    if (workOrders.length && !matches.length) {
      throw new Error('Update the project work orders to include their service and aircon details before generating kit items.');
    }
    for (const match of matches.length ? matches : [{ order: null, units: null }]) {
      const perUnit = item.ruleQuantityBasis === 'per_unit';
      const quantity = perUnit && match.units !== null ? Number(item.baseQuantity) * match.units
        : Number(item.quantity || 1) * (item.kind === 'equipment' && !perUnit ? Math.max(1, Number(crew) || 1) : 1);
      const existing = rows.find(row => ref(row.toolId) === ref(item.inventoryId) && row.itemName === item.name
        && ref(row.affectedWorkOrderIds?.[0]) === ref(match.order));
      if (existing) existing.quantity = item.kind === 'equipment' ? Math.max(existing.quantity, quantity) : existing.quantity + quantity;
      else rows.push({ itemName: item.name, type: item.kind, quantity, baseQuantity: quantity,
        requirementRule: 'fixed', unit: item.unit || 'pcs', scope: 'shared',
        affectedWorkOrderIds: match.order ? [match.order._id] : [], toolId: item.inventoryId || undefined,
        available: Number(item.available || 0), source: 'service_kit_rule', reason: 'Admin service kit rule',
      });
    }
  }
  return rows;
}
module.exports = { projectRuleResources };
