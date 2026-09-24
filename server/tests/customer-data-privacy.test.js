"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  presentTechnicianBooking,
  presentTechnicianApiPayload,
  presentTechnicianOrder,
  presentTechnicianPayment,
} = require("../utils/technicianDataPresentation");
const {
  grantPrivateUploads,
  isBookingEvidencePath,
} = require("../middleware/privateUploadAccess");
const { isTlsProtectedMongoUri } = require("../utils/mongoConnection");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, relativePath), "utf8");

test("technician booking and order presenters remove payment evidence and customer email", () => {
  const booking = presentTechnicianBooking({
    customer: { name: "Customer", phone: "09123456789", email: "private@example.com", address: "Service address" },
    paymentProof: "data:image/png;base64,secret",
    paymentReference: "PRIVATE-REFERENCE",
    gcashNumber: "09123456789",
    customerAccountAccess: { stateAtCheckout: "active" },
    adminNotes: "internal",
    service: { name: "Cleaning" },
  });
  assert.deepEqual(booking.customer, { name: "Customer", phone: "09123456789", address: "Service address" });
  assert.equal(booking.paymentProof, undefined);
  assert.equal(booking.paymentReference, undefined);
  assert.equal(booking.gcashNumber, undefined);
  assert.equal(booking.customerAccountAccess, undefined);
  assert.equal(booking.adminNotes, undefined);
  assert.equal(booking.service.name, "Cleaning");

  const order = presentTechnicianOrder({
    customer: { name: "Customer", phone: "09123456789", email: "private@example.com" },
    paymentId: "payment-id",
    paymentReference: "PRIVATE-REFERENCE",
    gcashNumber: "09123456789",
    gcashProofUrl: "/uploads/gcash-receipts/private.png",
    checkoutRequestId: "private-replay-key",
    items: [{ modelLine: "AC" }],
  });
  assert.deepEqual(order.customer, { name: "Customer", phone: "09123456789" });
  assert.equal(order.paymentId, undefined);
  assert.equal(order.paymentReference, undefined);
  assert.equal(order.gcashNumber, undefined);
  assert.equal(order.gcashProofUrl, undefined);
  assert.equal(order.checkoutRequestId, undefined);
  assert.equal(order.items[0].modelLine, "AC");
});

test("technician payment presenter is an allowlist", () => {
  const payment = presentTechnicianPayment({
    _id: "payment-id",
    amount: 500,
    method: "gcash",
    type: "downpayment",
    status: "verified",
    reference: "PRIVATE-REFERENCE",
    proofUrl: "data:image/png;base64,secret",
    customerSignature: "Customer Name",
    customerPhotoUrl: "/private/photo.png",
    remittanceNotes: "internal",
    events: [{ note: "internal event" }],
  });
  assert.deepEqual(payment, {
    _id: "payment-id",
    amount: 500,
    method: "gcash",
    type: "downpayment",
    status: "verified",
  });
});

test("technician API boundary recursively removes private customer and payment fields", () => {
  const response = presentTechnicianApiPayload({
    assignment: {
      customerName: "Customer",
      customerEmail: "private@example.com",
      customerId: { name: "Customer", email: "private@example.com" },
      bookingId: {
        customer: { name: "Customer", phone: "09123456789", email: "private@example.com" },
        paymentReference: "PRIVATE-REFERENCE",
        payments: [{ amount: 500, status: "verified", proofUrl: "/private/proof.png", events: [{}] }],
      },
    },
  });

  assert.equal(response.assignment.customerEmail, undefined);
  assert.equal(response.assignment.customerId.email, undefined);
  assert.equal(response.assignment.bookingId.customer.email, undefined);
  assert.equal(response.assignment.bookingId.paymentReference, undefined);
  assert.deepEqual(response.assignment.bookingId.payments, [{ amount: 500, status: "verified" }]);
});

test("technician customer tracking is constrained to assigned bookings", () => {
  const source = read("../routes/technicianApi.js");
  const start = source.indexOf('router.get("/tracking/customers"');
  const end = source.indexOf('router.post("/assignments/:id/proof-of-completion"', start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(route, /loadTechnicianContext\(req\.user\._id\)/);
  assert.match(route, /Assignment\.find\(/);
  assert.match(route, /technicianId:\s*\{\s*\$in:\s*technicianIds\s*\}/);
  assert.match(route, /"services\.technicianId":\s*\{\s*\$in:\s*technicianIds\s*\}/);
  assert.match(route, /_id:\s*\{\s*\$in:\s*assignmentBookingIds\s*\}/);
  assert.match(route, /customer\.name/);
  assert.doesNotMatch(route, /customer\.email/);
});

test("unassigned job queue does not reveal customer identity or address", () => {
  const source = read("../routes/technicianApi.js");
  const start = source.indexOf('router.get("/available-jobs"');
  const end = source.indexOf('router.post("/available-jobs/:bookingId/accept"', start);
  const route = source.slice(start, end);
  assert.match(route, /customerName:\s*"Customer"/);
  assert.match(route, /address:\s*"Shared after acceptance"/);
  assert.doesNotMatch(route, /b\.customer\?\./);
  assert.doesNotMatch(route, /b\.location\?\.address/);
});

test("private booking evidence requires a safe path and receives a short uploader grant", () => {
  assert.equal(isBookingEvidencePath("/uploads/proofs/proof-123.webp"), true);
  assert.equal(isBookingEvidencePath("/uploads/completion-proofs/done.png"), true);
  assert.equal(isBookingEvidencePath("/uploads/proofs/../private.png"), false);
  assert.equal(isBookingEvidencePath("/uploads/gcash-receipts/payment.png"), false);

  const req = { session: {} };
  grantPrivateUploads(req, ["/uploads/proofs/proof-123.webp", "/uploads/not-private/file.png"]);
  assert.equal(req.session.privateUploadGrants.length, 1);
  assert.equal(req.session.privateUploadGrants[0].url, "/uploads/proofs/proof-123.webp");
  assert.ok(req.session.privateUploadGrants[0].expiresAt > Date.now());

  const index = read("../index.js");
  assert.match(index, /requireBookingEvidenceAccess/);
  assert.match(index, /"\/uploads\/completion-proofs"[\s\S]*requireBookingEvidenceAccess/);
});

test("production transport policies require HTTPS for HTTP and MongoDB", () => {
  assert.equal(isTlsProtectedMongoUri("mongodb+srv://cluster.example/app"), true);
  assert.equal(isTlsProtectedMongoUri("mongodb://db.example:27017/app?tls=true"), true);
  assert.equal(isTlsProtectedMongoUri("mongodb://db.example:27017/app?ssl=true"), true);
  assert.equal(isTlsProtectedMongoUri("mongodb://db.example:27017/app"), false);

  const index = read("../index.js");
  assert.match(index, /Production MongoDB connections must enable TLS/);
  assert.match(index, /res\.redirect\(308, `\$\{origin\}\$\{req\.originalUrl\}`\)/);
});

test("booking creation logs do not print customer PII or submitted service payloads", () => {
  const modern = read("../routes/bookingRoutesNew.js");
  const legacy = read("../routes/bookingRoutes.js");
  assert.doesNotMatch(modern, /console\.(?:log|warn|error)\([^\n]*(?:req\.user\.email|booking\.customer\.email|location\.address|Services value:)/);
  assert.doesNotMatch(legacy, /console\.(?:log|warn|error)\([^\n]*User data:/);
});
