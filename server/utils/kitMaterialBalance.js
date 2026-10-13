'use strict';
function outstanding(item) {
  return Math.max(0, Number(item.quantityIssued || 0) - Number(item.quantityUsed || 0)
    - Number(item.quantityReturned || 0) - Number(item.quantityDamaged || 0) - Number(item.quantityMissing || 0));
}
function available(item) { return Math.max(0, outstanding(item) - Number(item.returnPendingQuantity || 0)); }
module.exports = { outstanding, available };
