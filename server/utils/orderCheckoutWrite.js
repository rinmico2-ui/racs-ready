"use strict";

const { assertCartSelection } = require("./cartCheckoutSelection");
const { OrderCheckoutError } = require("./orderCheckoutPolicy");
const { paymentRecordMethod } = require("./paymentPolicy");
const { isUnsupportedMongoWriteFeature } = require("./mongoWriteSupport");
const { isKnownStandalone } = require("./bookingSubmissionWrite");

async function persistOrderCheckout({
  mongoose, Order, Payment, Inventory, HVACProduct, AirconCart,
  orderData, enrichedItems, requestedItems, cartItemIds, user, receiptPresent,
}) {
  orderData._id ||= new mongoose.Types.ObjectId();
  const userId = user._id;
  const orderId = orderData._id;
  const paymentNeeded = ["cod", "gcash_full"].includes(orderData.paymentMethod) && receiptPresent;

  async function selectedCart(session) {
    if (!cartItemIds) return null;
    let query = AirconCart.findOne({ userId }).select("items");
    if (session) query = query.session(session);
    const cart = await query.lean();
    assertCartSelection(cart, cartItemIds, requestedItems);
    return cart;
  }

  async function removeSelectedCart(cart, session) {
    if (!cart) return;
    const selected = new Map(cart.items.map(item => [String(item._id), item]));
    const filter = {
      _id: cart._id, userId,
      $and: cartItemIds.map(id => {
        const item = selected.get(id);
        return { items: { $elemMatch: { _id: new mongoose.Types.ObjectId(id), inventoryId: item.inventoryId, quantity: item.quantity } } };
      }),
    };
    const options = session ? { session } : {};
    const result = await AirconCart.updateOne(filter, {
      $pull: { items: { _id: { $in: cartItemIds.map(id => new mongoose.Types.ObjectId(id)) } } },
    }, options);
    if (result.modifiedCount !== 1) {
      throw new OrderCheckoutError("Your cart changed. Refresh it before checking out.", 409, "ORDER_CART_SELECTION_CHANGED");
    }
  }

  async function reserveStock(session, reserved) {
    const options = session ? { returnDocument: "after", session } : { returnDocument: "after" };
    for (const item of enrichedItems) {
      const stock = item.isHvac
        ? await HVACProduct.findOneAndUpdate({
          _id: item.parentHvacId,
          variants: { $elemMatch: { _id: item.inventoryId, quantity: { $gte: item.quantity }, active: { $ne: false }, status: { $nin: ["out_of_stock", "discontinued", "coming_soon"] } } },
        }, { $inc: { "variants.$.quantity": -item.quantity } }, options)
        : await Inventory.findOneAndUpdate({
          _id: item.inventoryId, quantity: { $gte: item.quantity }, active: { $ne: false }, status: { $nin: ["out_of_stock", "discontinued", "coming_soon"] },
        }, { $inc: { quantity: -item.quantity } }, options);
      if (!stock) {
        throw new OrderCheckoutError(
          `${item.modelLine || "A selected product"} no longer has enough stock. Your order was not charged or created.`,
          409, "ORDER_STOCK_RACE_LOST",
        );
      }
      if (reserved) reserved.push(item);
    }
  }

  function paymentFor(order) {
    if (!paymentNeeded) return null;
    const downpayment = orderData.paymentMethod === "cod";
    const method = paymentRecordMethod(orderData.paymentChannel);
    return new Payment({
      orderId: order._id,
      amount: downpayment ? order.downpaymentAmount : order.total,
      method, type: downpayment ? "downpayment" : "final", gateway: method,
      reference: orderData.paymentReference || undefined,
      proofUrl: orderData.gcashProofUrl || null,
      status: "pending",
      notes: downpayment
        ? `${order.downpaymentPercentage}% order downpayment via ${orderData.paymentChannel} initiated`
        : `Full order payment via ${orderData.paymentChannel} initiated`,
      events: [{
        status: "pending", actor: userId,
        actorName: user.name || user.email || "Customer", actorRole: "customer",
        note: "Payment proof submitted with order", at: new Date(),
      }],
    });
  }

  async function write(session, reserved, attempted = {}) {
    const cart = await selectedCart(session);
    await reserveStock(session, reserved);
    const order = new Order(orderData);
    attempted.order = true;
    await order.save(session ? { session } : undefined);
    const payment = paymentFor(order);
    if (payment) {
      attempted.payment = true;
      await payment.save(session ? { session } : undefined);
      order.paymentId = payment._id;
      await order.save(session ? { session } : undefined);
    }
    await removeSelectedCart(cart, session);
    return { order, payment };
  }

  async function writeWithoutTransaction() {
    const reserved = [];
    const attempted = {};
    try {
      return (await write(null, reserved, attempted)).order;
    } catch (error) {
      const cleanupErrors = [];
      const undo = async operation => {
        try { await operation(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      };
      // The identifiers are fixed before the first write, so even a lost
      // acknowledgement can be checked and cleaned up by this request.
      if (attempted.order) await undo(() => Order.deleteOne({ _id: orderId, userId, checkoutRequestId: orderData.checkoutRequestId }));
      if (!cleanupErrors.length) {
        if (attempted.payment) await undo(() => Payment.deleteMany({ orderId }));
        for (const item of reserved.reverse()) {
          await undo(async () => {
            const result = item.isHvac
              ? await HVACProduct.updateOne({ _id: item.parentHvacId, "variants._id": item.inventoryId }, { $inc: { "variants.$.quantity": item.quantity } })
              : await Inventory.updateOne({ _id: item.inventoryId }, { $inc: { quantity: item.quantity } });
            if (result.matchedCount !== 1) throw new Error("Stock compensation did not find its product");
          });
        }
      }
      if (cleanupErrors.length) {
        error.cleanupErrors = cleanupErrors;
        error.preserveReceipt = true;
        error.status = 503;
        error.code = "ORDER_WRITE_INCOMPLETE";
      }
      throw error;
    }
  }

  if (!isKnownStandalone(mongoose.connection)) {
    let session;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
      const committed = (await write(session)).order;
      await session.commitTransaction();
      return committed;
    } catch (error) {
      await session?.abortTransaction().catch(() => {});
      if (!isUnsupportedMongoWriteFeature(error)) throw error;
      const existing = await Order.findOne({ userId, checkoutRequestId: orderData.checkoutRequestId });
      if (existing) {
        if (!paymentNeeded || (existing.paymentId && await Payment.exists({ _id: existing.paymentId, orderId: existing._id }))) return existing;
        throw Object.assign(new Error("Order write status is uncertain. Contact support before retrying."), {
          status: 503, code: "ORDER_WRITE_INCOMPLETE", preserveReceipt: true,
        });
      }
    } finally {
      await session?.endSession().catch(() => {});
    }
  }
  return writeWithoutTransaction();
}

module.exports = { persistOrderCheckout };
