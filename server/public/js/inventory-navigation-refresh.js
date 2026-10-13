(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  function isInventoryMutation(input, init, origin) {
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
      return url.origin === origin && /^\/api\/(?:pos(?:\/|$)|admin\/(?:hvac|tools|stock-adjustments|equipment-returns|daily-kit)(?:\/|$)|admin\/appointments\/(?:daily-kits|equipment-assignments|equipment-returns|kit-returns)(?:\/|$)|projects\/[^/]+\/materials(?:\/|$))/.test(url.pathname);
    } catch (_) { return false; }
  }
  function install(win) {
    if (!win || typeof win.fetch !== 'function' || win.__inventoryNavigationRefreshInstalled) return;
    win.__inventoryNavigationRefreshInstalled = true;
    const original = win.fetch;
    // Observe successful writes without consuming their response or changing
    // request options. Every inventory page uses the same refresh signal.
    win.fetch = function (input, init) {
      const inventoryWrite = isInventoryMutation(input, init, win.location.origin);
      return original.call(this, input, init).then(response => {
        if (inventoryWrite && response.ok && !response.redirected) win.dispatchEvent(new win.Event('inventory:changed'));
        return response;
      });
    };
  }
  return { isInventoryMutation, install };
});
