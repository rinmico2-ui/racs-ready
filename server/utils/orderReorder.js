"use strict";

const mongoose = require("mongoose");
const { OrderCheckoutError } = require("./orderCheckoutPolicy");

function reorderItems(order) {
  if (order.status !== "cancelled") {
    throw new OrderCheckoutError("Only cancelled orders can be reordered here.", 409, "REORDER_STATUS");
  }
  if (!Array.isArray(order.items) || !order.items.length || order.items.length > 50) {
    throw new OrderCheckoutError("This order has no restorable products. Please browse the catalog instead.", 409, "REORDER_ITEMS");
  }
  const items = new Map();
  for (const item of order.items) {
    const id = String(item.inventoryId || "");
    const quantity = Number(item.quantity);
    if (!/^[a-f\d]{24}$/i.test(id) || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new OrderCheckoutError("This order has invalid product details. Please browse the catalog instead.", 409, "REORDER_ITEMS");
    }
    const key = id.toLowerCase();
    const total = (items.get(key)?.quantity || 0) + quantity;
    if (!Number.isSafeInteger(total)) {
      throw new OrderCheckoutError("This order has invalid quantities.", 409, "REORDER_ITEMS");
    }
    items.set(key, { inventoryId: new mongoose.Types.ObjectId(key), quantity: total });
  }
  return [...items.values()];
}

// One atomic merge preserves other cart lines and makes retries non-additive.
// Cart entries contain IDs/quantities only: prices are resolved by the cart and
// revalidated by checkout, never copied from the cancelled order's snapshot.
function reorderCartUpdate(userId, items, now = new Date()) {
  const incoming = items.map(item => ({ ...item, _id: new mongoose.Types.ObjectId(), addedAt: now }));
  return [{ $set: {
    userId: new mongoose.Types.ObjectId(String(userId)),
    createdAt: { $ifNull: ["$createdAt", now] },
    updatedAt: now,
    __v: { $ifNull: ["$__v", 0] },
    items: { $reduce: {
      input: { $literal: incoming },
      initialValue: { $ifNull: ["$items", []] },
      in: { $cond: [
        { $in: ["$$this.inventoryId", "$$value.inventoryId"] },
        { $map: {
          input: "$$value", as: "line",
          in: { $cond: [
            { $eq: ["$$line.inventoryId", "$$this.inventoryId"] },
            { $mergeObjects: ["$$line", { quantity: { $max: ["$$line.quantity", "$$this.quantity"] } }] },
            "$$line",
          ] },
        } },
        { $concatArrays: ["$$value", ["$$this"]] },
      ] },
    } },
  } }];
}

async function reorderCancelledOrder({ orderId, userId }, models) {
  if (!/^[a-f\d]{24}$/i.test(String(orderId))) {
    throw new OrderCheckoutError("Invalid order ID.", 400, "REORDER_ID");
  }
  const { Order, Inventory, HVACProduct, AirconCart } = models;
  // Owner-scoped query also hides other customers' order details.
  const order = await Order.findOne({ _id: orderId, userId })
    .select("status items.inventoryId items.quantity").maxTimeMS(5000).lean();
  if (!order) throw new OrderCheckoutError("Order not found.", 404, "REORDER_NOT_FOUND");
  const items = reorderItems(order);
  const ids = items.map(item => item.inventoryId);
  const [inventory, products] = await Promise.all([
    Inventory.find({ _id: { $in: ids } }).select("modelLine quantity active status sellingPrice").maxTimeMS(5000).lean(),
    HVACProduct.find({ "variants._id": { $in: ids }, active: { $ne: false } })
      .select("modelLine active variants._id variants.quantity variants.active variants.status variants.sellingPrice")
      .maxTimeMS(5000).lean(),
  ]);
  const available = new Map(inventory.map(item => [String(item._id), item]));
  for (const product of products) {
    for (const variant of product.variants || []) {
      const id = String(variant._id);
      if (!available.has(id)) available.set(id, { ...variant, modelLine: product.modelLine });
    }
  }
  // Validate every line before touching the cart. Checkout reserves stock later.
  for (const item of items) {
    const current = available.get(String(item.inventoryId));
    const stock = Number(current?.quantity);
    const price = Number(current?.sellingPrice);
    if (!current || current.active === false || ["out_of_stock", "discontinued", "coming_soon"].includes(current.status)
      || !Number.isFinite(stock) || stock < item.quantity
      || current.sellingPrice == null || !Number.isFinite(price) || price < 0) {
      throw new OrderCheckoutError(
        `${current?.modelLine || "A product in this order"} is unavailable in the requested quantity. Your cart has not been changed.`,
        409, "REORDER_UNAVAILABLE",
      );
    }
  }
  const filter = { userId: new mongoose.Types.ObjectId(String(userId)) };
  const update = reorderCartUpdate(userId, items);
  try {
    // Native pipeline deliberately supplies ObjectIds, line IDs and timestamps;
    // Mongoose does not cast update pipelines or apply schema defaults to them.
    await AirconCart.collection.updateOne(filter, update, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    // A concurrent first cart creation can win the unique userId insert.
    const result = await AirconCart.collection.updateOne(filter, update);
    if (result.matchedCount !== 1) throw error;
  }
  return { message: "Items restored to your cart. Review current prices, availability and payment before placing a new order." };
}

module.exports = { reorderItems, reorderCartUpdate, reorderCancelledOrder };
