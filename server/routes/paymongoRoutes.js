const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const paymongo = require("../utils/paymongo");
const Payment = require("../models/Payment");

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
    if (eventType === "source.chargeable") {
      const attributes = resource?.attributes || {};
      const metadata = attributes.metadata || {};
      const paymentRecord = await Payment.findOne({
        $or: [
          ...(metadata.paymentId ? [{ _id: metadata.paymentId }] : []),
          ...(resource?.id ? [{ gatewayId: resource.id }] : []),
          ...(metadata.bookingId ? [{ bookingId: metadata.bookingId }] : []),
          ...(metadata.orderId ? [{ orderId: metadata.orderId }] : []),
        ],
      }).sort({ submittedAt: -1 });
      if (paymentRecord) {
        const charged = await paymongo.createPaymentFromSource({
          sourceId: resource.id,
          amount: Number(attributes.amount || 0) / 100,
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
                attributes: { status: charged.status, metadata: { ...metadata, paymentId: String(paymentRecord._id) } },
              },
            },
          },
        };
      }
    }
    await paymentController.handleGatewayWebhook(event);
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
