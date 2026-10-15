'use strict';
const { isReportable } = require('./reportingScope');
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
function normalizeStockRow(row) {
  const quantity = count(row.quantity), reserved = count(row.reservedQuantity);
  const unavailable = row.inventoryClass === 'operational_asset' && (row.assignable === false || ['under_maintenance','damaged','retired'].includes(row.assetStatus) || row.assetCondition === 'damaged');
  const available = unavailable ? 0 : Math.max(0, quantity - reserved);
  const minStockLevel = row.minStockLevel == null ? 3 : count(row.minStockLevel);
  const status = row.status === 'discontinued' ? 'discontinued' : available <= 0 ? 'out_of_stock' : available <= minStockLevel ? 'low_stock' : 'in_stock';
  return { ...row, quantity, reservedQuantity: reserved, availableQuantity: available, checkedOutQuantity: count(row.checkedOutQuantity), minStockLevel, status };
}
function stockCatalog(inventory = [], products = []) {
  const rows = inventory.filter(row => row.active !== false && isReportable(row)).map(normalizeStockRow);
  const ids = new Set(rows.map(row => String(row._id)));
  for (const product of products.filter(row => row.active !== false && isReportable(row))) {
    for (const variant of product.variants || []) {
      if (variant.active === false || ids.has(String(variant._id))) continue;
      ids.add(String(variant._id));
      rows.push(normalizeStockRow({ ...product, ...variant, _id: variant._id, parentHvacId: product._id,
        modelLine: `${product.modelLine || 'Aircon'} ${variant.capacity || ''} ${variant.capacityUnit || 'HP'}`.trim(), variants: undefined }));
    }
  }
  return rows;
}
function stockSnapshot(inventory, products, tools = []) {
  const rows = [...stockCatalog(inventory, products), ...tools.filter(row => row.active !== false && isReportable(row)).map(normalizeStockRow)]
    .filter(row => row.status !== 'discontinued');
  return { skuCount: rows.length, units: rows.reduce((sum, row) => sum + row.quantity, 0), outOfStock: rows.filter(row => row.availableQuantity <= 0).length,
    lowStock: rows.filter(row => row.availableQuantity > 0 && row.availableQuantity <= row.minStockLevel).length };
}
async function loadStockSnapshot() {
  const Inventory = require('../models/Inventory'), HVACProduct = require('../models/HVACProduct'), Tool = require('../models/Tool');
  const fields = '_id active status archivedAt testDataExcludedAt quantity reservedQuantity minStockLevel inventoryClass type assignable assetStatus assetCondition checkedOutQuantity';
  const [inventory, products, tools] = await Promise.all([
    Inventory.find({ active: { $ne: false } }).select(fields).lean(),
    HVACProduct.find({ active: { $ne: false } }).select('_id active archivedAt testDataExcludedAt variants._id variants.active variants.status variants.quantity variants.reservedQuantity variants.minStockLevel').lean(),
    Tool.find({ active: { $ne: false } }).select(fields).lean(),
  ]);
  return stockSnapshot(inventory, products, tools.map(tool => ({ ...tool, inventoryClass: Tool.effectiveInventoryClass(tool) })));
}
module.exports = { stockCatalog, stockSnapshot, normalizeStockRow, loadStockSnapshot };
