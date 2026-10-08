'use strict';
const round = value => Math.round((Number(value) || 0) * 100) / 100;

// Keep the rounded checkout discount on the eligible item lines. These recorded
// amounts are also used for item returns and product contribution reporting.
function allocateLoyaltyDiscount(lines, reward) {
  if (!reward?.amount) return lines.map(() => 0);
  const ids = new Set(reward.eligibleItemIds || []);
  const bases = lines.map(line => line.eligible !== false && ids.has(String(line.id)) ? Math.max(0, round(line.amount)) : 0);
  const base = bases.reduce((sum, value) => sum + value, 0);
  const cents = Math.round(reward.amount * 100);
  const allocated = bases.map(value => base ? Math.floor(cents * value / base) : 0);
  let remaining = cents - allocated.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remaining > 0 && index < allocated.length; index++) {
    if (bases[index] > 0) { allocated[index]++; remaining--; }
  }
  return allocated.map(value => value / 100);
}

function lineDiscount(source, item) {
  const gross = round(item.totalPrice ?? Number(item.unitPrice || 0) * Math.max(1, Number(item.quantity) || 1));
  if (item.discountAmount != null) return Math.min(gross, Math.max(0, round(item.discountAmount)));
  const subtotal = Number(source.subtotal) || (source.items || []).reduce((sum, line) => sum + Number(line.totalPrice || 0), 0);
  return subtotal > 0 ? Math.min(gross, Math.max(0, gross * (Number(source.discount) || 0) / subtotal)) : 0;
}
function netLineValue(source, item) {
  const gross = round(item.totalPrice ?? Number(item.unitPrice || 0) * Math.max(1, Number(item.quantity) || 1));
  return round(Math.max(0, gross - lineDiscount(source, item)));
}
function serviceLineValue(service) {
  const quantity = Math.max(1, Number(service.quantity) || 1);
  const amount = service.finalCost != null && service.costUpdatedByTechnician
    ? Number(service.finalCost) * quantity : Number(service.totalPrice ?? Number(service.unitPrice || 0) * quantity);
  return round(Math.max(0, amount || 0));
}
module.exports = { allocateLoyaltyDiscount, lineDiscount, netLineValue, serviceLineValue };
