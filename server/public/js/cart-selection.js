(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CartSelection = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function canPurchase(item) {
    const product = item?.inventoryId || {};
    const quantity = Number(item?.quantity);
    const stock = Number(product.quantity);
    return Boolean(item?._id) && Number.isInteger(quantity) && quantity > 0
      && product.active !== false && !["out_of_stock", "discontinued", "coming_soon"].includes(product.status)
      && (!Number.isFinite(stock) || (stock >= quantity && stock > 0));
  }
  function selectedCart(cart, ids) {
    const selected = new Set(ids.map(String));
    const items = (cart?.items || []).filter(item => selected.has(String(item._id)) && canPurchase(item));
    const totalAmount = items.reduce((sum, item) => sum + (Number(item.inventoryId?.sellingPrice) || 0) * Number(item.quantity), 0);
    return { items, totalAmount };
  }
  function init(options) {
    const root = window;
    const document = root.document;
    const cart = options.cart || { items: [] };
    const checkboxes = Array.from(document.querySelectorAll(".cart-item-select"));
    const selectAll = document.getElementById("cartSelectAll");
    const checkout = document.getElementById("cartCheckoutSelected");
    const storageKey = "racs_cart_selection_v1_" + String(options.customerId || "");
    let saved = null;
    try {
      const parsed = JSON.parse(root.sessionStorage.getItem(storageKey));
      if (Array.isArray(parsed?.knownIds) && Array.isArray(parsed?.selectedIds)) saved = parsed;
    } catch (_) { /* Selection still works when storage is unavailable. */ }
    const known = new Set(saved?.knownIds || []);
    const selected = new Set(saved?.selectedIds || []);
    const items = new Map((cart.items || []).map(item => [String(item._id), item]));
    checkboxes.forEach(checkbox => {
      const id = checkbox.dataset.cartItemId;
      checkbox.disabled = !canPurchase(items.get(id));
      checkbox.checked = !checkbox.disabled && (!known.has(id) || selected.has(id));
    });
    function currentCart() {
      return selectedCart(cart, checkboxes.filter(checkbox => checkbox.checked && !checkbox.disabled).map(checkbox => checkbox.dataset.cartItemId));
    }
    function text(id, value) {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    }
    function refresh() {
      const current = currentCart();
      const eligible = checkboxes.filter(checkbox => !checkbox.disabled);
      const selectedCount = current.items.length;
      const units = current.items.reduce((sum, item) => sum + Number(item.quantity), 0);
      const money = "\u20b1" + current.totalAmount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      text("cartSelectionCount", selectedCount + " of " + eligible.length + " available items selected");
      text("cartSelectedUnits", units);
      text("cartSelectedSubtotal", money);
      text("cartSelectedTotal", money);
      text("cartCheckoutSelectedLabel", "Checkout selected (" + selectedCount + ")");
      if (checkout) checkout.disabled = selectedCount === 0;
      if (selectAll) {
        selectAll.disabled = eligible.length === 0;
        selectAll.checked = eligible.length > 0 && selectedCount === eligible.length;
        selectAll.indeterminate = selectedCount > 0 && selectedCount < eligible.length;
      }
      checkboxes.forEach(checkbox => {
        const row = document.getElementById("item-" + checkbox.dataset.cartItemId);
        row?.classList.toggle("is-selected", checkbox.checked && !checkbox.disabled);
      });
      try {
        root.sessionStorage.setItem(storageKey, JSON.stringify({
          knownIds: checkboxes.map(checkbox => checkbox.dataset.cartItemId),
          selectedIds: current.items.map(item => String(item._id)),
        }));
      } catch (_) {}
    }
    root.getSelectedCartForCheckout = currentCart;
    checkboxes.forEach(checkbox => checkbox.addEventListener("change", refresh));
    selectAll?.addEventListener("change", () => {
      checkboxes.forEach(checkbox => { if (!checkbox.disabled) checkbox.checked = selectAll.checked; });
      refresh();
    });
    refresh();
  }
  return { canPurchase, selectedCart, init };
});
