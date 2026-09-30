"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const ui = require("../public/js/cart-selection");
const { parseCartItemIds, assertCartSelection } = require("../utils/cartCheckoutSelection");
const ids = ["507f1f77bcf86cd799439041", "507f1f77bcf86cd799439042", "507f1f77bcf86cd799439043"];
const inventoryIds = ["507f1f77bcf86cd799439021", "507f1f77bcf86cd799439022", "507f1f77bcf86cd799439023"];
const cart = { items: ids.map((_id, index) => ({ _id, quantity: index + 1,
  inventoryId: { _id: inventoryIds[index], modelLine: "Aircon " + index, quantity: index === 2 ? 0 : 10, sellingPrice: 1000 * (index + 1) } })) };

test("selected totals contain only checked, available items without changing the cart", () => {
  const selected = ui.selectedCart(cart, [ids[1], ids[2], "unknown"]);
  assert.deepEqual(selected.items.map(item => item._id), [ids[1]]);
  assert.equal(selected.totalAmount, 4000);
  assert.equal(cart.items.length, 3);
  assert.deepEqual(ui.selectedCart(cart, []).items, []);
  for (const status of ["out_of_stock", "discontinued", "coming_soon"]) {
    assert.equal(ui.canPurchase({ ...cart.items[0], inventoryId: { ...cart.items[0].inventoryId, status } }), false);
  }
});

function fixture(saved, storageBlocked = false) {
  const elements = new Map();
  function node(id) {
    if (!elements.has(id)) elements.set(id, { textContent: "", checked: false, disabled: false, dataset: {},
      classList: { toggle() {} }, events: {}, addEventListener(type, callback) { this.events[type] = callback; } });
    return elements.get(id);
  }
  const checkboxes = ids.map(id => { const checkbox = node("checkbox-" + id); checkbox.dataset.cartItemId = id; return checkbox; });
  const stored = new Map(saved ? [["racs_cart_selection_v1_customer", JSON.stringify(saved)]] : []);
  const window = { document: { querySelectorAll: () => checkboxes, getElementById: node }, sessionStorage: {
    getItem(key) { if (storageBlocked) throw new Error("blocked"); return stored.get(key) || null; },
    setItem(key, value) { if (storageBlocked) throw new Error("blocked"); stored.set(key, value); },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/cart-selection.js"), "utf8"), { window });
  window.CartSelection.init({ customerId: "customer", cart });
  return { node, checkboxes, window, stored };
}

test("checkboxes, select-all, mixed state, selected total and empty checkout update together", () => {
  const f = fixture();
  assert.deepEqual(f.checkboxes.map(item => item.checked), [true, true, false]);
  assert.equal(f.checkboxes[2].disabled, true);
  assert.equal(f.node("cartSelectedSubtotal").textContent, "₱5,000.00");
  f.checkboxes[0].checked = false; f.checkboxes[0].events.change();
  assert.equal(f.node("cartSelectAll").indeterminate, true);
  assert.equal(f.node("cartSelectedSubtotal").textContent, "₱4,000.00");
  assert.equal(f.window.getSelectedCartForCheckout().items.length, 1);
  f.node("cartSelectAll").checked = false; f.node("cartSelectAll").events.change();
  assert.equal(f.node("cartCheckoutSelected").disabled, true);
  assert.equal(f.node("cartSelectedUnits").textContent, 0);
  f.node("cartSelectAll").checked = true; f.node("cartSelectAll").events.change();
  assert.equal(f.node("cartCheckoutSelected").disabled, false);
  assert.equal(f.node("cartSelectAll").indeterminate, false);
  assert.equal(f.checkboxes[2].checked, false);
});

test("selection survives quantity-page reloads and still works with blocked session storage", () => {
  const f = fixture({ knownIds: ids, selectedIds: [ids[1]] });
  assert.deepEqual(f.checkboxes.map(item => item.checked), [false, true, false]);
  const saved = JSON.parse(f.stored.get("racs_cart_selection_v1_customer"));
  assert.deepEqual(saved.selectedIds, [ids[1]]);
  const blocked = fixture(null, true);
  blocked.node("cartSelectAll").checked = false; blocked.node("cartSelectAll").events.change();
  assert.equal(blocked.node("cartCheckoutSelected").disabled, true);
});

test("server accepts only nonempty, unique, well-formed cart line IDs", () => {
  assert.equal(parseCartItemIds(undefined), null);
  assert.deepEqual(parseCartItemIds(JSON.stringify([ids[0]])), [ids[0]]);
  for (const value of [null, "bad JSON", [], ["unknown"], [ids[0], ids[0]], [ids[0], ids[0].toUpperCase()], Array(51).fill(ids[0])]) {
    assert.throws(() => parseCartItemIds(value), error => error.code === "ORDER_CART_SELECTION_INVALID");
  }
});

test("server checks selected lines against the owned cart, product IDs and exact quantities", () => {
  const stored = { items: cart.items.map(item => ({ ...item, inventoryId: item.inventoryId._id })) };
  assert.doesNotThrow(() => assertCartSelection(stored, [ids[1]], [{ inventoryId: inventoryIds[1], quantity: 2 }]));
  for (const [ownedCart, selected, ordered] of [
    [null, [ids[0]], [{ inventoryId: inventoryIds[0], quantity: 1 }]],
    [stored, [ids[0]], [{ inventoryId: inventoryIds[1], quantity: 1 }]],
    [stored, [ids[0]], [{ inventoryId: inventoryIds[0], quantity: 2 }]],
    [stored, [ids[0]], [{ inventoryId: inventoryIds[0], quantity: 1 }, { inventoryId: inventoryIds[1], quantity: 2 }]],
  ]) assert.throws(() => assertCartSelection(ownedCart, selected, ordered), error => error.code === "ORDER_CART_SELECTION_CHANGED");
});

test("cart view renders selection controls and initializes them before draft restoration", async () => {
  const html = await ejs.renderFile(path.join(__dirname, "../views/pages/aircon-cart.ejs"), { cart, user: { _id: "customer", phone: "09171234567" } });
  assert.equal((html.match(/class="cart-item-select"/g) || []).length, 3);
  assert.match(html, /id="cartSelectAll"/);
  assert.match(html, /id="cartSelectedTotal"/);
  assert.match(html, /id="cartCheckoutSelected"/);
  assert.ok(html.indexOf("window.CartSelection.init") < html.indexOf("const initialCheckoutCart"));
  assert.doesNotMatch(html, /fetch\('\/api\/aircon-cart\/clear'/);
  assert.match(html, /fd\.append\('cartItemIds'/);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (script[1].trim()) assert.doesNotThrow(() => new Function(script[1]));
  }
});
