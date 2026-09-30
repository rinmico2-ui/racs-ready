"use strict";
const { OrderCheckoutError } = require("./orderCheckoutPolicy");

function parseCartItemIds(value) {
  if (value === undefined) return null; // Direct product checkout has no cart.
  let ids = value;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch (_) { ids = null; }
  }
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50
    || ids.some(id => typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id))
    || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
    throw new OrderCheckoutError("Select valid cart items before checking out.", 400, "ORDER_CART_SELECTION_INVALID");
  }
  return ids.map(id => id.toLowerCase());
}

function assertCartSelection(cart, ids, requestedItems) {
  const byId = new Map((cart?.items || []).map(item => [String(item._id), item]));
  const requested = new Map(requestedItems.map(item => [String(item.inventoryId), Number(item.quantity)]));
  const selected = ids.map(id => byId.get(id));
  const productIds = new Set(selected.filter(Boolean).map(item => String(item.inventoryId)));
  if (selected.length !== requestedItems.length || productIds.size !== selected.length
    || selected.some(item => !item || requested.get(String(item.inventoryId)) !== Number(item.quantity))) {
    throw new OrderCheckoutError("Your selected cart items changed. Refresh your cart and select the items again.", 409, "ORDER_CART_SELECTION_CHANGED");
  }
}

module.exports = { parseCartItemIds, assertCartSelection };
