"use strict";

const methods = {
  cash: { booking: "cod", channel: "other", method: "cash", gateway: "cod" },
  cod: { booking: "cod", channel: "other", method: "cash", gateway: "cod" },
  gcash: { booking: "gcash", channel: "gcash", method: "gcash", gateway: "gcash" },
  maya: { booking: "other", channel: "maya", method: "maya", gateway: "maya" },
  card: { booking: "card", channel: "card", method: "card", gateway: "other" },
  bank_transfer: { booking: "other", channel: "bank_transfer", method: "bank", gateway: "bank" },
};
function walkInPayment(input, total, now = new Date()) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400, code: "WALK_IN_PAYMENT_INVALID" }); };
  if (input.paymentMethod !== undefined && typeof input.paymentMethod !== "string") fail("Choose Cash, GCash, Maya, Card, or Bank transfer.");
  const method = input.paymentMethod === undefined ? "cash" : input.paymentMethod.trim().toLowerCase();
  const mapping = Object.hasOwn(methods, method) ? methods[method] : null;
  if (!mapping) fail("Choose Cash, GCash, Maya, Card, or Bank transfer.");
  const mode = input.cashPaymentMode ?? "downpayment";
  if (!["full", "downpayment"].includes(mode)) fail("Choose full payment or downpayment.");
  const rawAmount = input.downpaymentAmount;
  const amount = (typeof rawAmount === "string" && rawAmount.trim() === "") || !["string", "number"].includes(typeof rawAmount) ? NaN : Number(rawAmount);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) fail("Enter a valid amount collected, with at most two decimal places.");
  if (Math.round(amount * 100) > Math.round(total * 100)) fail("The amount collected cannot exceed the total fee.");
  if (mode === "full" && Math.round(amount * 100) !== Math.round(total * 100)) fail("Full payment must match the total fee.");
  const rawReference = input.paymentReference ?? "";
  if (typeof rawReference !== "string" || rawReference.length > 160 || /[\x00-\x1f\x7f]/.test(rawReference)) fail("Enter a valid payment reference of at most 160 characters.");
  let reference = rawReference.trim();
  if (mapping.method !== "cash" && reference.length < 4) fail("Enter the electronic payment or card authorization reference.");
  if (!reference) reference = `OR-${require("crypto").randomUUID()}`;
  return { ...mapping, source: method === "cod" ? "cash" : method, mode, reference, amount: Math.round(amount * 100) / 100,
    status: Math.round(amount * 100) === Math.round(total * 100) ? "paid" : "partial", now };
}

module.exports = { walkInPayment };
