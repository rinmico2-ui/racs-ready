"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

function viewerFixture() {
  class Element extends EventTarget {
    constructor(id) {
      super(); this.id = id; this.attributes = {}; this.parentElement = {};
      const classes = new Set();
      this.classList = {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
      };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
    focus() { this.focused = true; }
  }
  const elements = Object.fromEntries(["paymentImageModal", "paymentDetailsModal", "paymentImageModalImg",
    "paymentImageStatus", "detailsProofLink"].map(id => [id, new Element(id)]));
  const body = { appendChild(element) { element.parentElement = body; } };
  const calls = [];
  const instances = new Map();
  const bootstrap = { Modal: { getOrCreateInstance(element) {
    if (!instances.has(element)) instances.set(element, {
      show() {
        for (const other of [elements.paymentDetailsModal, elements.paymentImageModal]) {
          if (other !== element) assert.equal(other.hiding || other.classList.contains("show"), false, "Do not stack modals or backdrops");
        }
        calls.push(element.id + ":show");
        element.classList.add("show");
        element.dispatchEvent(new Event("shown.bs.modal"));
      },
      hide() {
        calls.push(element.id + ":hide");
        element.classList.remove("show");
        element.hiding = true;
      },
    });
    return instances.get(element);
  } } };
  const window = { bootstrap };
  const document = { readyState: "complete", body, getElementById: id => elements[id] || null };
  vm.runInNewContext(read("public/js/payment-receipt-viewer.js"), { window, document, bootstrap });
  function finishHide(element) {
    element.hiding = false;
    element.classList.remove("show");
    element.dispatchEvent(new Event("hidden.bs.modal"));
  }
  return { ...elements, window, bootstrap, body, calls, finishHide };
}

test("receipt waits for the details backdrop to close and restores details/focus afterward", () => {
  const f = viewerFixture();
  assert.equal(f.paymentImageModal.parentElement, f.body);
  assert.equal(f.paymentDetailsModal.parentElement, f.body);
  f.paymentDetailsModal.classList.add("show");
  f.window.openPaymentImage("data:image/png;base64,receipt");
  assert.deepEqual(f.calls, ["paymentDetailsModal:hide"]);
  // A rapid second click must not create another modal or replace its receipt.
  f.window.openPaymentImage("/different-receipt.png");
  assert.equal(f.paymentImageModalImg.src, "data:image/png;base64,receipt");
  f.finishHide(f.paymentDetailsModal);
  assert.deepEqual(f.calls, ["paymentDetailsModal:hide", "paymentImageModal:show"]);
  f.paymentImageModalImg.dispatchEvent(new Event("load"));
  assert.equal(f.paymentImageModalImg.classList.contains("d-none"), false);
  assert.equal(f.paymentImageStatus.textContent, "");
  f.bootstrap.Modal.getOrCreateInstance(f.paymentImageModal).hide();
  f.finishHide(f.paymentImageModal);
  assert.equal(f.paymentDetailsModal.classList.contains("show"), true);
  assert.equal(f.detailsProofLink.focused, true);
  assert.equal(f.paymentImageModalImg.src, undefined);
  assert.equal(f.paymentImageModal.attributes["aria-busy"], "false");
});

test("receipt load failures show an accessible error and a retry opens cleanly", () => {
  const f = viewerFixture();
  f.window.openPaymentImage("/missing.png");
  f.paymentImageModalImg.dispatchEvent(new Event("error"));
  assert.equal(f.paymentImageStatus.attributes.role, "alert");
  assert.match(f.paymentImageStatus.textContent, /could not load/);
  assert.equal(f.paymentImageModalImg.classList.contains("d-none"), true);
  f.bootstrap.Modal.getOrCreateInstance(f.paymentImageModal).hide();
  f.finishHide(f.paymentImageModal);
  assert.equal(f.paymentDetailsModal.classList.contains("show"), false);
  f.window.openPaymentImage("/valid.png");
  f.paymentImageModalImg.dispatchEvent(new Event("load"));
  assert.equal(f.paymentImageStatus.classList.contains("d-none"), true);
  assert.equal(f.paymentImageModalImg.classList.contains("d-none"), false);
});

test("repeated receipt viewing has no accumulating restore handlers and ignores empty sources", () => {
  const f = viewerFixture();
  f.window.openPaymentImage("");
  f.window.openPaymentImage(null);
  assert.equal(f.calls.length, 0);
  f.paymentDetailsModal.classList.add("show");
  for (let i = 0; i < 3; i++) {
    f.window.openPaymentImage("/receipt-" + i + ".png");
    f.finishHide(f.paymentDetailsModal);
    f.bootstrap.Modal.getOrCreateInstance(f.paymentImageModal).hide();
    f.finishHide(f.paymentImageModal);
  }
  assert.equal(f.calls.filter(call => call === "paymentImageModal:show").length, 3);
  assert.equal(f.calls.filter(call => call === "paymentDetailsModal:show").length, 3);
});

test("payment rows have exactly eight visible cells in the same order as both templates", () => {
  const script = read("public/js/admin-payments.js");
  const render = script.slice(script.indexOf("  function escapeHtml"), script.indexOf("  let currentPaymentId"));
  const tbody = { innerHTML: "" };
  const context = { tbody, highlightedBookingId: null, highlightedOrderId: null };
  vm.runInNewContext(render + '\nrenderRows([{"_id":"payment-1","customerName":"Jane","customerEmail":"<unsafe>@example.com","bookingReference":"ORD-1","amount":25515,"method":"gcash","status":"pending","submittedAt":"2026-09-29T05:00:00Z","reference":"reference-1"}]);', context);
  const cells = [...tbody.innerHTML.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[0]);
  assert.equal(cells.length, 8);
  assert.match(cells[0], /payment-1[\s\S]*reference-1/);
  assert.match(cells[1], /Jane[\s\S]*&lt;unsafe&gt;/);
  assert.match(cells[2], /ORD-1/);
  assert.match(cells[3], /text-end[\s\S]*25,515/);
  assert.match(cells[4], /GCash/);
  assert.match(cells[5], /PENDING/);
  assert.match(cells[6], /2026/);
  assert.match(cells[7], /js-view-details/);
  assert.ok(cells.every(cell => !/^<td[^>]*d-none/.test(cell)));
  vm.runInNewContext("renderRows([]);", context);
  assert.match(tbody.innerHTML, /colspan="8"/);
  for (const name of ["Payments", "PaymentsList"]) {
    const filename = path.join(root, "views/pages/admin/Payments/" + name + ".ejs");
    const html = ejs.render(fs.readFileSync(filename, "utf8"), {}, { filename });
    const headers = [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map(match => match[1]);
    assert.deepEqual(headers, ["Transaction ID", "Customer", "Booking Ref", "Amount", "Method", "Status", "Date", "Actions"]);
    assert.match(html, /payment-transactions-table/);
    assert.match(html, /payment-receipt-viewer\.js\?v=20260929-receipt-table/);
    assert.doesNotMatch(html, /z-index:\s*999[09]/);
    assert.match(html, /aria-labelledby="paymentImageModalLabel"/);
  }
});

test("opening order payment details still returns its full receipt despite compact list responses", async t => {
  const mongoose = require("mongoose");
  const Payment = require("../models/Payment");
  const Order = require("../models/Order");
  const Booking = require("../models/BookingService");
  const paymentId = new mongoose.Types.ObjectId();
  const orderId = new mongoose.Types.ObjectId();
  const proof = "data:image/png;base64,test-receipt";
  t.mock.method(Payment, "findById", () => ({ lean: async () => ({ _id: paymentId, orderId, status: "pending", amount: 25515, method: "gcash" }) }));
  t.mock.method(Booking, "findById", () => { throw new Error("An order payment does not need a booking query"); });
  t.mock.method(Order, "findById", () => ({ lean: async () => ({ _id: orderId, orderReference: "ORD-TEST", gcashProofUrl: proof,
    customer: { name: "Test Customer", email: "test@example.com" }, paymentStatus: "pending", total: 25515 }) }));
  let payload;
  await require("../controllers/paymentController").getPayment({ params: { id: String(paymentId) } }, {
    json(body) { payload = body; },
  }, error => { throw error; });
  assert.equal(payload.payment.proofUrl, proof);
  assert.equal(payload.payment.bookingReference, "ORD-TEST");
});
