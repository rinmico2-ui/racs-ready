const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const paymongo = require("../utils/paymongo");
const Payment = require("../models/Payment");
const GatewayWebhookEvent = require("../models/GatewayWebhookEvent");
const { withOperationLock } = require("../utils/operationLock");

async function webhookHandler(req, res) {
  let event;
  try {
    event = paymongo.verifyWebhook(req.body, req.headers["paymongo-signature"], process.env.PAYMONGO_WEBHOOK_SECRET);
  } catch (error) {
    console.warn("paymongo webhook signature error", error.message);
    return res.status(400).send("invalid");
  }

  try {
    const eventType = event?.data?.attributes?.type;
    const resource = event?.data?.attributes?.data;
    if (!["source.chargeable", "payment.paid", "payment.failed", "checkout_session.payment.paid", "checkout_session.payment.failed"].includes(eventType)) return res.status(200).send("OK");
    const eventId = event?.data?.id;
    if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,140}$/.test(eventId)) return res.status(400).send("invalid");
    await withOperationLock(`paymongo-event:${eventId}`, async () => {
      if (await GatewayWebhookEvent.exists({ _id: `paymongo:${eventId}` })) return;
      if (eventType === "source.chargeable") {
        const attributes = resource?.attributes || {};
        const metadata = attributes.metadata || {};
        if (typeof resource?.id !== "string") throw new Error("Invalid payment source");
        const paymentRecord = await Payment.findOne({ $or: [{ gatewayId: resource.id }, { gatewaySourceId: resource.id }] }).sort({ submittedAt: -1 });
        if (paymentRecord && !["verified", "refunded", "completed"].includes(paymentRecord.status)) {
          if (attributes.currency !== "PHP" || attributes.amount !== Math.round(Number(paymentRecord.amount) * 100)) throw new Error("Payment amount mismatch");
          if (paymentRecord.gatewaySourceId !== resource.id) {
            paymentRecord.gatewaySourceId = resource.id;
            await paymentRecord.save();
          }
          const charged = paymentRecord.status === "paid" ? { paymentId: paymentRecord.gatewayId, status: "paid" } : await paymongo.createPaymentFromSource({
            sourceId: resource.id,
            amount: Number(paymentRecord.amount),
            description: `Payment for ${metadata.reference || metadata.bookingId || metadata.orderId}`,
            metadata: { ...metadata, paymentId: String(paymentRecord._id) },
          });
          event = {
            ...event,
            data: {
              ...event.data,
              attributes: {
                ...event.data.attributes,
                type: charged.status === "paid" ? "payment.paid" : "payment.failed",
                data: {
                  id: charged.paymentId,
                  type: "payment",
                  attributes: { status: charged.status, amount: attributes.amount, currency: "PHP", source: { id: resource.id }, metadata: { ...metadata, paymentId: String(paymentRecord._id) } },
                },
              },
            },
          };
        } else return;
      }
      await paymentController.handleGatewayWebhook(event);
      await GatewayWebhookEvent.create({ _id: `paymongo:${eventId}`, processedAt: new Date() });
    }, { waitMs: 3000, leaseMs: 90000 });
    return res.status(200).send("OK");
  } catch (error) {
    console.error("paymongo webhook processing error", error.message);
    return res.status(500).send("error");
  }
}

router.post("/checkout-session", (_req, res) => {
  return res.status(410).json({
    error: "Online card checkout is no longer available. Card payments are collected in person, and card details must not be entered into this website.",
  });
});

module.exports = router;
module.exports.webhookHandler = webhookHandler;
