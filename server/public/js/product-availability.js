(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProductAvailability = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function availability(item, parent) {
    item = item || {};
    parent = parent || {};
    var stock = Number(item.quantity);
    stock = Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0;
    var status = item.status;
    var message = '';
    if (item.active === false || parent.active === false) message = 'This product is no longer available.';
    else if (status === 'discontinued' || parent.status === 'discontinued') message = 'This product has been discontinued.';
    else if (status === 'coming_soon' || parent.status === 'coming_soon') message = 'This product is coming soon and cannot be purchased yet.';
    else if (parent.salesChannel && !['web', 'both'].includes(parent.salesChannel)) message = 'This product is available in store only.';
    else if (!stock) message = 'This HP option is out of stock. Please select another configuration.';
    // in_stock, low_stock and out_of_stock are derived from quantity. A stale
    // out_of_stock label must not make a replenished variant impossible to buy.
    var derivedStatus = stock === 0 ? 'out_of_stock' : stock <= Number(item.minStockLevel == null ? 3 : item.minStockLevel) ? 'low_stock' : 'in_stock';
    var explicitStatus = ['discontinued', 'coming_soon'].includes(status) ? status : ['discontinued', 'coming_soon'].includes(parent.status) ? parent.status : null;
    return { available: !message, stock: stock, status: explicitStatus || derivedStatus, message: message };
  }
  return { availability: availability };
});
