"use strict";

const { OrderCheckoutError } = require("./orderCheckoutPolicy");
const RECEIVED_PAYMENT_STATUSES = ["verified", "paid", "remitted", "partial", "payment_collected", "waiting_for_remittance"];
const REFUND_STATES = ["pending", "processing", "completed", "partial"];
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function refundResult(order, alreadyRequested) {
  return {
    alreadyRequested,
    refundStatus: order.refundStatus,
    refundAmount: Number(order.refundAmount) || 0,
    message: alreadyRequested
      ? "This order already has a refund record. No duplicate request was created."
      : "Refund request submitted for administrator review. This does not transfer money automatically.",
  };
}

function reviewResult(alreadyRequested) {
  return { alreadyRequested, refundReviewStatus: "pending_verification", refundStatus: "none", refundAmount: 0,
    message: alreadyRequested
      ? "Payment review has already been requested. No duplicate request was created."
      : "Payment review requested. Staff will verify your receipt before deciding whether a refund is due. No money has been marked refundable yet." };
}

async function requestOrderRefund({ orderId, user, reason, actor = user, promoteReview = false }, { mongoose, Order, Payment, ProductRefund }) {
  if (!/^[a-f\d]{24}$/i.test(String(orderId))) {
    throw new OrderCheckoutError("Invalid order ID.", 400, "REFUND_ORDER_ID");
  }
  if (typeof reason !== "string" || reason.trim().length < 10 || reason.trim().length > 500) {
    throw new OrderCheckoutError("Please provide a refund reason between 10 and 500 characters.", 400, "REFUND_REASON");
  }
  const refundReason = reason.trim();
  const session = await mongoose.startSession();
  try {
    // withTransaction retries write conflicts: concurrent requests must touch
    // the same order/payment records and cannot produce two requests.
    return await session.withTransaction(async () => {
      const order = await Order.findOne({ _id: orderId, userId: user._id }).session(session);
      if (!order) throw new OrderCheckoutError("Order not found.", 404, "REFUND_ORDER_NOT_FOUND");
      if (order.status !== "cancelled") {
        throw new OrderCheckoutError("Refund requests here are only for cancelled orders.", 409, "REFUND_ORDER_STATUS");
      }
      if (REFUND_STATES.includes(order.refundStatus)) return refundResult(order, true);
      if (order.refundReviewRequestedAt && !promoteReview) return reviewResult(true);

      const payments = await Payment.find({ orderId: order._id, status: { $in: [...RECEIVED_PAYMENT_STATUSES, "refunded"] } })
        .select("amount status refundStatus refundAmount refundReason rmaRefundVersion __v")
        .session(session).maxTimeMS(5000);
      if (await ProductRefund.exists({ sourceType: "order", sourceId: order._id, status: { $in: ["approved", "processing", "completed"] } }).session(session)) {
        throw new OrderCheckoutError("This order has an item-level refund. Please contact the administrator to review the remaining refundable amount.", 409, "REFUND_PRODUCT_RETURN");
      }

      let total = 0;
      let completed = 0;
      let processing = false;
      let outstanding = false;
      let created = false;
      const now = new Date();
      for (const payment of payments) {
        const amount = money(payment.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        if (REFUND_STATES.includes(payment.refundStatus)) {
          // Reconcile legacy requests rather than replacing amounts or events.
          const recorded = money(payment.refundAmount);
          if (!Number.isFinite(recorded) || recorded <= 0 || recorded > amount) {
            throw new OrderCheckoutError("An existing refund record needs administrator review.", 409, "REFUND_REVIEW_REQUIRED");
          }
          total = money(total + recorded);
          if (payment.refundStatus === "completed") completed = money(completed + recorded);
          else outstanding = true;
          if (payment.refundStatus === "processing") processing = true;
          continue;
        }
        if (payment.status === "refunded") continue;
        if (Number(payment.refundAmount) > 0) {
          throw new OrderCheckoutError("An existing refund amount needs administrator review.", 409, "REFUND_REVIEW_REQUIRED");
        }
        // Conditional write conflicts with a concurrent refund/return approval.
        // It also preserves the original payment and all prior audit events.
        const updated = await Payment.updateOne({
          _id: payment._id, status: { $in: RECEIVED_PAYMENT_STATUSES },
          refundStatus: { $in: ["none", null] },
          rmaRefundVersion: payment.rmaRefundVersion || { $in: [0, null] },
        }, {
          $set: { refundStatus: "pending", refundAmount: amount, refundMethod: "original", refundReason },
          $inc: { rmaRefundVersion: 1, __v: 1 },
          $push: { events: { status: "refund_pending", actor: actor._id, actorRole: actor.role || "customer",
            actorName: actor.name || actor.email || "Customer", note: refundReason, at: now } },
        }, { session });
        if (updated.modifiedCount !== 1) {
          throw new OrderCheckoutError("Payment or refund details changed. Refresh and try again.", 409, "REFUND_PAYMENT_CHANGED");
        }
        total = money(total + amount);
        outstanding = true;
        created = true;
      }
      if (total <= 0) {
        if (!promoteReview && await Payment.exists({ orderId: order._id, status: "pending",
          proofUrl: { $exists: true, $nin: [null, ""] } }).session(session)) {
          order.refundReviewRequestedAt = now;
          order.refundReviewReason = refundReason;
          await order.save({ session });
          return reviewResult(false);
        }
        throw new OrderCheckoutError("No eligible received payment is recorded for this order. If you already paid, contact the administrator with your receipt.", 409, "REFUND_PAYMENT_NOT_CONFIRMED");
      }
      order.refundStatus = outstanding ? (completed > 0 ? "partial" : (processing ? "processing" : "pending")) : "completed";
      order.refundAmount = total;
      order.refundReason = order.refundReason || refundReason;
      order.refundRequestedAt = order.refundRequestedAt || now;
      await order.save({ session });
      return refundResult(order, !created);
    });
  } finally {
    await session.endSession();
  }
}

module.exports = { requestOrderRefund, RECEIVED_PAYMENT_STATUSES };
