"use strict";

const mongoose = require("mongoose");
const { OrderCheckoutError } = require("./orderCheckoutPolicy");

// Historical order lines keep their original stock IDs. Never guess a new
// variant from its name/HP when that original catalog entry has been removed.
async function restoreCancelledOrderStock(items, { Inventory, HVACProduct }, session) {
  const missing = [];
  for (const item of items || []) {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new OrderCheckoutError("This order has an invalid unit quantity. Ask staff to check the order before cancelling.", 409, "ORDER_STOCK_QUANTITY_INVALID");
    }
    let restored = null;
    if (mongoose.isObjectIdOrHexString(item.inventoryId)
      && (!item.isHvac || mongoose.isObjectIdOrHexString(item.parentHvacId))) {
      restored = item.isHvac
        ? await HVACProduct.findOneAndUpdate(
          { _id: item.parentHvacId, "variants._id": item.inventoryId },
          { $inc: { "variants.$.quantity": quantity } }, { session },
        )
        : await Inventory.findByIdAndUpdate(item.inventoryId, { $inc: { quantity } }, { session });
    }
    if (!restored) missing.push({
      inventoryId: item.inventoryId || null,
      parentHvacId: item.parentHvacId || null,
      isHvac: Boolean(item.isHvac),
      name: [item.brand, item.modelLine, item.capacity ? `${item.capacity} ${item.capacityUnit || "HP"}` : ""].filter(Boolean).join(" ") || "Aircon",
      quantity,
      reason: "The original stock item is no longer in the inventory. No stock was added for this line.",
    });
  }
  return { status: missing.length ? "pending_review" : "completed", checkedAt: new Date(), items: missing };
}

module.exports = { restoreCancelledOrderStock };
