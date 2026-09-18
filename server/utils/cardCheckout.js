const Payment = require("../models/Payment");
const paymongo = require("./paymongo");

function applicationBaseUrl(req) {
  const configured = String(process.env.APP_BASE_URL || process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}`;
}

async function createCardCheckout({ paymentId, booking, order, customer, req }) {
  const existing = await Payment.findById(paymentId).select("+gatewayCheckoutUrl");
  if (!existing) throw Object.assign(new Error("Payment record not found."), { status: 404 });
  if (existing.status === "paid") throw Object.assign(new Error("This payment is already complete."), { status: 409 });
  if (existing.gatewayStatus === "active" && existing.gatewayCheckoutUrl) {
    return { checkoutUrl: existing.gatewayCheckoutUrl, checkoutSessionId: existing.gatewayId, reused: true };
  }

  const locked = await Payment.findOneAndUpdate(
    { _id: paymentId, status: { $in: ["pending", "failed"] }, gatewayStatus: { $ne: "creating" } },
    { $set: { status: "pending", gateway: "paymongo", gatewayType: "checkout_session", gatewayStatus: "creating" } },
    { returnDocument: "after" },
  );
  if (!locked) throw Object.assign(new Error("Card checkout is already being prepared. Please try again in a moment."), { status: 409 });

  const baseUrl = applicationBaseUrl(req);
  const isBooking = Boolean(booking);
  const resource = booking || order;
  const reference = booking?.bookingReference || order?.orderReference || String(resource._id);
  const successPath = isBooking ? "/book-history" : "/my-orders";
  const cancelPath = isBooking ? "/services" : "/my-orders";
  const resourceQuery = isBooking ? `booking=${encodeURIComponent(resource._id)}` : `order=${encodeURIComponent(resource._id)}`;

  try {
    const session = await paymongo.createCardCheckoutSession({
      amount: locked.amount,
      description: `${locked.type === "downpayment" ? "Downpayment" : "Payment"} for ${reference}`,
      referenceNumber: reference,
      successUrl: `${baseUrl}${successPath}?payment=success&${resourceQuery}`,
      cancelUrl: `${baseUrl}${cancelPath}?payment=cancelled&${resourceQuery}`,
      billingName: customer?.name,
      billingEmail: customer?.email,
      billingPhone: customer?.phone,
      metadata: {
        paymentId: String(locked._id),
        ...(isBooking ? { bookingId: String(resource._id) } : { orderId: String(resource._id) }),
        reference,
        paymentType: locked.type,
      },
    });
    await Payment.findByIdAndUpdate(locked._id, {
      $set: {
        gateway: "paymongo",
        gatewayId: session.checkoutSessionId,
        gatewayType: "checkout_session",
        gatewayStatus: session.status || "active",
        gatewayCheckoutUrl: session.checkoutUrl,
        reference: session.referenceNumber || reference,
      },
      $push: {
        events: {
          status: "pending",
          actor: customer?._id,
          actorName: customer?.name || customer?.email || "Customer",
          actorRole: "customer",
          note: "Secure card checkout created",
          at: new Date(),
          metadata: { checkoutSessionId: session.checkoutSessionId },
        },
      },
    });
    return session;
  } catch (error) {
    await Payment.findByIdAndUpdate(locked._id, {
      $set: { gatewayStatus: "failed" },
      $push: { events: { status: "failed", actorRole: "system", note: "Card checkout creation failed", at: new Date() } },
    }).catch(() => {});
    const gatewayMessage = error.response?.data?.errors?.[0]?.detail;
    const wrapped = new Error(gatewayMessage || "Secure card checkout is temporarily unavailable. Please try another payment method or try again shortly.");
    wrapped.status = 502;
    throw wrapped;
  }
}

module.exports = { applicationBaseUrl, createCardCheckout };
