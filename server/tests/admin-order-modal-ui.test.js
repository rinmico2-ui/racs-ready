"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const source = read("public/js/admin-aircon-orders.js");

function fixture() {
  let document;
  class Element extends EventTarget {
    constructor(tag = "div") {
      super(); this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.dataset = {};
      const classes = new Set();
      this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
    }
    get isConnected() { return Boolean(this.parentElement); }
    appendChild(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; delete this[key]; }
    focus() { document.activeElement = this; }
    contains(child) { return this.children.includes(child); }
    querySelector(selector) { return this.children.find(child => selector === '[role="alert"]' && child.attributes.role === "alert") || null; }
  }
  document = new EventTarget();
  document.body = new Element("body");
  document.createElement = tag => new Element(tag);
  const details = new Element(); details.id = "aoDetailsModal";
  document.body.appendChild(details);
  document.getElementById = id => id === details.id ? details : null;
  const focus = new Element("button"); details.appendChild(focus); focus.focus();
  const window = {};
  return { document, details, window, Element, focus };
}

test("order modals move above page containers before Bootstrap creates a backdrop", () => {
  const f = fixture();
  const element = new f.Element();
  const sequence = [];
  const bootstrap = { Modal: { getOrCreateInstance(target) {
    assert.equal(target.parentElement, f.document.body);
    sequence.push("instance"); return { show() { sequence.push("show"); } };
  } } };
  const modalCode = source.slice(source.indexOf("  const fallbackModals"), source.indexOf("  const modalEl"));
  vm.runInNewContext(modalCode + "\norderModal(element).show();", { window: { bootstrap }, bootstrap, document: f.document, element });
  assert.deepEqual(sequence, ["instance", "show"]);
});

test("delivery order details open before fetching and retain an on-demand receipt button", async () => {
  const f = fixture();
  const body = new f.Element();
  const context = {
    window: f.window, document: f.document, modal: { show() { f.details.classList.add("show"); } },
    modalBody: body, modalSubtitle: {}, modalFooter: { style: {} }, viewedOrderId: null,
    orderDetailRequest: 0, orderDetailController: null, AbortController,
    esc: value => String(value ?? ""), currency: value => "PHP " + Number(value || 0),
    fmtDate: () => "2026-09-29", fmtTime: value => value, fmtManilaDateTime: () => "2026-09-29",
    niceStatus: value => value, orderStatusLabel: order => order.status, paymentLabel: () => "GCash",
    FULFILL_LABELS: { delivery_only: "Delivery Only" }, canAssign: () => false,
    isAdminWorkspace: true, canResolveOrders: true,
    operationsFetchJson: async (url, options) => {
      assert.equal(f.details.classList.contains("show"), true);
      assert.equal(url, "/api/orders/order-1?view=modal");
      assert.ok(options.signal);
      return { photosDeferred: true, order: { _id: "order-1", orderReference: "ORD-TEST", fulfillmentType: "delivery_only",
        status: "pending_payment", paymentStatus: "pending", paymentMethod: "gcash", items: [], total: 25515 } };
    },
  };
  const detailsCode = source.slice(source.indexOf("  window._aoViewOrder ="), source.indexOf("  window._aoResendCustomerActivation"));
  vm.runInNewContext(detailsCode, context);
  await f.window._aoViewOrder("order-1");
  assert.equal(context.modalSubtitle.textContent, "ORD-TEST");
  assert.match(body.innerHTML, /Payment Receipt[\s\S]*_aoLoadPhotos\('order-1',this,'receipt'\)/);
  assert.match(body.innerHTML, /View photos and receipts/);
  assert.doesNotMatch(body.innerHTML, /data:image/);
});

function photosFixture(fetch) {
  const f = fixture();
  const container = new f.Element(); f.details.appendChild(container);
  const button = new f.Element("button"); button.textContent = "View Receipt"; container.appendChild(button);
  const opened = [];
  const context = { window: { openAoImage: src => opened.push(src) }, document: f.document,
    orderDetailRequest: 1, viewedOrderId: "order-1", orderDetailController: new AbortController(), operationsFetchJson: fetch };
  vm.runInNewContext(source.slice(source.indexOf("  window._aoLoadPhotos ="), source.indexOf("  window._aoViewOrder =")), context);
  return { ...f, context, container, button, opened };
}

test("receipt button fetches protected photos and opens only the payment receipt", async () => {
  const f = photosFixture(async (url, options) => {
    assert.equal(url, "/api/orders/order-1/photos"); assert.ok(options.signal);
    return { photos: [{ label: "Arrival", src: "arrival" }, { label: "Payment receipt", src: "receipt" }] };
  });
  await f.context.window._aoLoadPhotos("order-1", f.button, "receipt");
  assert.deepEqual(f.opened, ["receipt"]);
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.textContent, "View Receipt");
});

test("missing receipts show a retryable message and superseded photo requests never open old evidence", async () => {
  const missing = photosFixture(async () => ({ photos: [] }));
  await missing.context.window._aoLoadPhotos("order-1", missing.button, "receipt");
  assert.match(missing.container.querySelector('[role="alert"]').textContent, /No payment receipt/);
  assert.equal(missing.button.disabled, false);
  let release;
  const stale = photosFixture(() => new Promise(resolve => { release = resolve; }));
  const pending = stale.context.window._aoLoadPhotos("order-1", stale.button, "receipt");
  stale.context.orderDetailRequest++;
  stale.context.viewedOrderId = "order-2";
  release({ photos: [{ label: "Payment receipt", src: "old-receipt" }] });
  await pending;
  assert.equal(stale.opened.length, 0);
});

test("evidence viewer stays inside the active focus trap, preserves its close button on errors and handles Escape", () => {
  const f = fixture(); f.details.classList.add("show");
  vm.runInNewContext(read("public/js/order-evidence-viewer.js"), { window: f.window, document: f.document });
  const src = 'https://example.test/image?name="quoted"';
  f.window.openAoImage(src);
  const overlay = f.details.children.find(child => child.id === "aoImageOverlay");
  assert.ok(overlay);
  const [close, message, image] = overlay.children[0].children;
  assert.equal(image.src, src);
  assert.equal(f.document.activeElement, close);
  image.dispatchEvent(new Event("error"));
  assert.equal(message.attributes.role, "alert");
  assert.match(message.textContent, /Image unavailable/);
  assert.equal(close.isConnected, true);
  const tab = new Event("keydown", { cancelable: true }); Object.defineProperty(tab, "key", { value: "Tab" });
  f.document.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  const escape = new Event("keydown", { cancelable: true }); Object.defineProperty(escape, "key", { value: "Escape" });
  f.document.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(overlay.isConnected, false);
  assert.equal(f.document.activeElement, f.focus);
  assert.equal(f.details.classList.contains("show"), true);
});

test("receipt overlay is cleaned up when its parent modal closes or another image replaces it", () => {
  const f = fixture(); f.details.classList.add("show");
  vm.runInNewContext(read("public/js/order-evidence-viewer.js"), { window: f.window, document: f.document });
  f.window.openAoImage("receipt-1");
  f.window.openAoImage("receipt-2");
  assert.equal(f.details.children.filter(child => child.id === "aoImageOverlay").length, 1);
  f.details.classList.remove("show");
  f.details.dispatchEvent(new Event("hidden.bs.modal"));
  assert.equal(f.details.children.filter(child => child.id === "aoImageOverlay").length, 0);
  const escape = new Event("keydown", { cancelable: true }); Object.defineProperty(escape, "key", { value: "Escape" });
  f.document.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false);
});

function diagnosticFixture(fetch) {
  const f = fixture(); f.details.classList.add("show");
  Object.assign(f.window, { location: { href: "http://localhost:5000/admin/appointments/orders", origin: "http://localhost:5000" },
    fetch, setTimeout, clearTimeout });
  vm.runInNewContext(read("public/js/order-evidence-viewer.js"), { window: f.window, document: f.document, URL, AbortController });
  f.window.openAoImage("uploads/gcash-receipts/receipt.png");
  const overlay = f.details.children.find(child => child.id === "aoImageOverlay");
  const [close, message, image, retry] = overlay.children[0].children;
  return { ...f, overlay, close, message, image, retry };
}

test("legacy root-relative upload URLs are corrected and missing files explain recovery", async () => {
  const f = diagnosticFixture(async (url, options) => {
    assert.equal(url, "http://localhost:5000/uploads/gcash-receipts/receipt.png");
    assert.equal(options.method, "HEAD");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    return { status: 404, ok: false };
  });
  assert.equal(f.image.src, "/uploads/gcash-receipts/receipt.png");
  f.image.dispatchEvent(new Event("error"));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.message.textContent, /file is missing from this server/);
  assert.match(f.message.textContent, /re-upload/);
  assert.equal(f.retry.classList.contains("d-none"), false);
  f.retry.dispatchEvent(new Event("click"));
  assert.equal(f.message.textContent, "Loading image...");
  f.image.dispatchEvent(new Event("load"));
  assert.equal(f.retry.classList.contains("d-none"), true);
  f.window.closeAoImage();
});

test("image failures distinguish sessions, permissions and throttling", async () => {
  for (const [status, expected] of [[401, /session has expired/], [403, /permission/], [429, /too many requests/], [503, /HTTP 503/]]) {
    const f = diagnosticFixture(async () => ({ status, ok: false }));
    f.image.dispatchEvent(new Event("error"));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(f.message.textContent, expected);
    f.window.closeAoImage();
  }
});

test("closing the viewer aborts diagnostics and ignores late failures", async () => {
  let release, signal;
  const f = diagnosticFixture((url, options) => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  });
  f.image.dispatchEvent(new Event("error"));
  f.window.closeAoImage();
  assert.equal(signal.aborted, true);
  release({ status: 404, ok: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(f.message.textContent, /file is missing/);
  assert.equal(f.overlay.isConnected, false);
});

test("remote image errors never send diagnostic requests to another origin", async () => {
  let requests = 0;
  const f = diagnosticFixture(async () => { requests++; });
  f.window.openAoImage("https://other.example/private.png");
  const overlay = f.details.children.find(child => child.id === "aoImageOverlay");
  overlay.children[0].children[2].dispatchEvent(new Event("error"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
  f.window.closeAoImage();
});
