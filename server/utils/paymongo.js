const axios = require("axios");
const crypto = require("crypto");

const API_BASE = "https://api.paymongo.com/v1";

function getSecretKey() {
  const key = process.env.PAYMONGO_SECRET_KEY;
  if (!key) throw new Error("PAYMONGO_SECRET_KEY not set in environment");
  return key;
}

function getPublicKey() {
  const key = process.env.PAYMONGO_PUBLIC_KEY;
  if (!key) throw new Error("PAYMONGO_PUBLIC_KEY not set in environment");
  return key;
}

function isPaymongoConfigured() {
  return Boolean(
    String(process.env.PAYMONGO_SECRET_KEY || "").trim()
    && String(process.env.PAYMONGO_WEBHOOK_SECRET || "").trim(),
  );
}

/**
 * Create a hosted PayMongo Checkout Session for card payments. Card numbers,
 * expiry dates and CVCs are entered on PayMongo's page and never touch RACS.
 */
async function createCardCheckoutSession({
  amount,
  description,
  successUrl,
  cancelUrl,
  referenceNumber,
  billingName,
  billingEmail,
  billingPhone,
  metadata = {},
}) {
  const key = getSecretKey();
  const amountCentavos = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(amountCentavos) || amountCentavos < 100) {
    throw new Error("Card payment amount must be at least ₱1.00.");
  }
  if (!successUrl || !cancelUrl) {
    throw new Error("Card checkout redirect URLs are required.");
  }

  const billing = {};
  if (billingName) billing.name = String(billingName).trim();
  if (billingEmail) billing.email = String(billingEmail).trim();
  if (billingPhone) billing.phone = String(billingPhone).trim();

  const safeDescription = String(description || "RACS payment").trim().slice(0, 255);
  const payload = {
    data: {
      attributes: {
        billing: Object.keys(billing).length ? billing : undefined,
        cancel_url: String(cancelUrl),
        description: safeDescription,
        line_items: [{
          amount: amountCentavos,
          currency: "PHP",
          description: safeDescription,
          name: "RACS payment",
          quantity: 1,
        }],
        payment_method_types: ["card"],
        reference_number: String(referenceNumber || "RACS").slice(0, 100),
        send_email_receipt: true,
        show_description: true,
        show_line_items: true,
        success_url: String(successUrl),
        metadata,
      },
    },
  };

  const resp = await axios.post(`${API_BASE}/checkout_sessions`, payload, {
    auth: { username: key, password: "" },
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });
  const session = resp.data?.data;
  const attrs = session?.attributes || {};
  if (!session?.id || !attrs.checkout_url) {
    throw new Error("PayMongo did not return a usable card checkout session.");
  }
  return {
    checkoutSessionId: session.id,
    checkoutUrl: attrs.checkout_url,
    referenceNumber: attrs.reference_number || referenceNumber,
    status: attrs.status || "active",
    amountPHP: amountCentavos / 100,
  };
}

/**
 * Create a GCash Source via PayMongo Sources API.
 * Returns { sourceId, checkoutUrl, status } on success.
 *
 * @param {object} opts
 * @param {number}  opts.amount        Amount in PHP (will be converted to centavos internally)
 * @param {string}  opts.description   Short description shown on checkout page
 * @param {string}  opts.successUrl    URL to redirect after successful payment
 * @param {string}  opts.failedUrl     URL to redirect after failed/cancelled payment
 * @param {string}  [opts.billingName] Customer full name
 * @param {string}  [opts.billingEmail] Customer email address
 * @param {string}  [opts.billingPhone] Customer phone number (+639XXXXXXXXX)
 * @param {object}  [opts.metadata]    Arbitrary key-value metadata (e.g. bookingId)
 */
async function createGcashSource({
  amount,
  description,
  successUrl,
  failedUrl,
  billingName,
  billingEmail,
  billingPhone,
  metadata = {},
}) {
  const key = getSecretKey();

  // PayMongo amounts are in centavos (PHP × 100)
  const amountCentavos = Math.round(Number(amount) * 100);
  if (!amountCentavos || amountCentavos < 100) {
    throw new Error("Amount must be at least ₱1.00 for a GCash payment.");
  }

  const billing = {};
  if (billingName)  billing.name  = String(billingName).trim();
  if (billingEmail) billing.email = String(billingEmail).trim();
  if (billingPhone) billing.phone = String(billingPhone).trim();

  const payload = {
    data: {
      attributes: {
        amount:   amountCentavos,
        currency: "PHP",
        type:     "gcash",
        description: description || "Service Booking",
        redirect: {
          success: successUrl,
          failed:  failedUrl,
        },
        ...(Object.keys(billing).length > 0 ? { billing } : {}),
        metadata,
      },
    },
  };

  const resp = await axios.post(`${API_BASE}/sources`, payload, {
    auth:    { username: key, password: "" },
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  const src = resp.data?.data;
  const attrs = src?.attributes || {};
  return {
    sourceId:    src?.id,
    checkoutUrl: attrs.redirect?.checkout_url,
    status:      attrs.status, // "pending" initially
    type:        attrs.type,   // "gcash"
    amountPHP:   (attrs.amount || amountCentavos) / 100,
  };
}

/**
 * Create a PayMongo Payment Link (newer Links API).
 * Useful for generating shareable payment links.
 *
 * @param {object} opts
 * @param {number}  opts.amount      Amount in PHP
 * @param {string}  opts.description Short description
 * @param {string}  [opts.remarks]   Optional additional remarks
 */
async function createPaymentLink({ amount, description, remarks }) {
  const key = getSecretKey();
  const amountCentavos = Math.round(Number(amount) * 100);

  const payload = {
    data: {
      attributes: {
        amount:      amountCentavos,
        currency:    "PHP",
        description: description || "Service Booking",
        ...(remarks ? { remarks } : {}),
      },
    },
  };

  const resp = await axios.post(`${API_BASE}/links`, payload, {
    auth:    { username: key, password: "" },
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  const link = resp.data?.data;
  const attrs = link?.attributes || {};
  return {
    linkId:      link?.id,
    checkoutUrl: attrs.checkout_url,
    referenceNumber: attrs.reference_number,
    status:      attrs.status,
    amountPHP:   (attrs.amount || amountCentavos) / 100,
  };
}

/**
 * Retrieve a Source from PayMongo (to check payment status after webhook).
 */
async function getSource(sourceId) {
  const key = getSecretKey();
  const resp = await axios.get(`${API_BASE}/sources/${sourceId}`, {
    auth:    { username: key, password: "" },
    headers: { "Content-Type": "application/json" },
    timeout: 10000,
  });
  return resp.data?.data;
}

async function getPayment(paymentId) {
  const key = getSecretKey();
  const resp = await axios.get(`${API_BASE}/payments/${paymentId}`, {
    auth:    { username: key, password: "" },
    headers: { "Content-Type": "application/json" },
    timeout: 10000,
  });
  return resp.data?.data;
}

/**
 * Create a Payment against an existing Source (chargeable source).
 * Called after the source becomes chargeable (webhook: source.chargeable).
 */
async function createPaymentFromSource({ sourceId, amount, description, metadata = {} }) {
  const key = getSecretKey();
  const amountCentavos = Math.round(Number(amount) * 100);

  const payload = {
    data: {
      attributes: {
        amount:      amountCentavos,
        currency:    "PHP",
        source: {
          id:   sourceId,
          type: "source",
        },
        description: description || "Service Booking",
        metadata,
      },
    },
  };

  const resp = await axios.post(`${API_BASE}/payments`, payload, {
    auth:    { username: key, password: "" },
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  const payment = resp.data?.data;
  const attrs   = payment?.attributes || {};
  return {
    paymentId: payment?.id,
    status:    attrs.status,   // "paid" | "failed"
    amountPHP: (attrs.amount || amountCentavos) / 100,
  };
}

/**
 * Verify a PayMongo webhook signature.
 * PayMongo signs with HMAC-SHA256; the header format is:
 *   t=<timestamp>,te=<test_sig>,li=<live_sig>
 */
function verifyWebhook(rawBody, signatureHeader, secret) {
  if (!signatureHeader) throw new Error("Missing PayMongo Signature header");

  const parts = {};
  signatureHeader.split(",").forEach((p) => {
    const [k, v] = p.split("=");
    if (k && v) parts[k.trim()] = v.trim();
  });

  const timestamp = parts.t;
  const sigKey    = process.env.NODE_ENV === "production" ? "li" : "te";
  const signature = parts[sigKey];

  if (!timestamp || !signature) {
    throw new Error("Malformed PayMongo Signature header");
  }

  const toSign   = `${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(toSign).digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
    throw new Error("Invalid PayMongo webhook signature");
  }

  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
  } catch (e) {
    throw new Error("Unable to parse webhook payload");
  }
}

module.exports = {
  isPaymongoConfigured,
  createCardCheckoutSession,
  createGcashSource,
  createPaymentLink,
  getSource,
  getPayment,
  createPaymentFromSource,
  verifyWebhook,
};
