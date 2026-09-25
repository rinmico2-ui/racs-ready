"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = relative => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
const serviceView = read("views/pages/services.ejs");
const cartView = read("views/partials/cart-wizard.ejs");
const productView = read("views/partials/aircons.ejs");
const paymentPolicy = read("utils/paymentPolicy.js");
const adminRoutes = read("routes/adminApi.js");
const adminSettings = read("views/pages/admin/Settings/System.ejs");
const qrActions = read("public/js/gcash-qr-actions.js");

test("service and both product checkouts offer download only for a genuine configured QR", () => {
  for (const source of [serviceView, cartView, productView]) {
    assert.match(source, /data-gcash-qr-download/);
    assert.match(source, /data-gcash-qr-image/);
    assert.match(source, /gcash-qr-actions\.js/);
    assert.match(source, /https:\/\/gcash\.com\/getting-started/);
    assert.doesNotMatch(source, /api\.qrserver\.com|encodeURIComponent\('GCash\|'/);
  }
  assert.match(qrActions, /link\.classList\.toggle\('d-none', !qrUrl\)/);
  assert.match(qrActions, /link\.download = `CALIDRO-GCash-QR\./);
});

test("a QR is hidden when its saved receiving number no longer matches", () => {
  assert.match(paymentPolicy, /setting\?\.value\?\.recipientNumber !== recipientNumber/);
  assert.match(paymentPolicy, /gcashQrImageUrl/);
  assert.match(adminRoutes, /router\.post\("\/settings\/payment-policy\/gcash-qr"/);
  assert.match(adminRoutes, /gcashQrExtension\(req\.file\?\.buffer\)/);
  assert.match(adminRoutes, /value: \{ url: gcashQrImageUrl, recipientNumber \}/);
  assert.match(adminSettings, /id="gcashRecipientNumber"/);
  assert.match(adminSettings, /id="gcashQrUpload"/);
  assert.match(adminSettings, /showCurrentQr\(result\.data\.gcashQrImageUrl\)/);
});

test("the supplied QR is bundled for the verified current recipient only", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "../public/images/gcash-receiver-qr.jpg")), true);
  assert.match(paymentPolicy, /recipientHash === BUNDLED_GCASH_RECIPIENT_SHA256/);
  assert.match(paymentPolicy, /BUNDLED_GCASH_QR_URL = "\/images\/gcash-receiver-qr\.jpg"/);
  assert.match(qrActions, /value === '\/images\/gcash-receiver-qr\.jpg'/);
});

test("download appears only for a local uploaded image", () => {
  const element = () => ({
    classList: { names: new Set(), toggle(name, on) { if (on) this.names.add(name); else this.names.delete(name); } },
    removeAttribute(name) { delete this[name]; },
  });
  const image = element();
  const link = element();
  const label = element();
  const missing = element();
  const elements = {
    "[data-gcash-qr-image]": [image],
    "[data-gcash-qr-download]": [link],
    "[data-gcash-qr-label]": [label],
    "[data-gcash-qr-missing]": [missing],
  };
  const context = { window: {}, document: { readyState: "complete", querySelectorAll: selector => elements[selector] || [] } };
  vm.runInNewContext(qrActions, context);

  context.window.GcashQrActions.apply("https://example.com/fake.png");
  assert.equal(image.src, undefined);
  assert.equal(link.href, undefined);
  assert.equal(link.classList.names.has("d-none"), true);

  context.window.GcashQrActions.apply("/uploads/payment-qr/gcash-abc.png");
  assert.equal(image.src, "/uploads/payment-qr/gcash-abc.png");
  assert.equal(link.href, image.src);
  assert.equal(link.download, "CALIDRO-GCash-QR.png");
  assert.equal(link.classList.names.has("d-none"), false);
  assert.equal(missing.classList.names.has("d-none"), true);

  context.window.GcashQrActions.apply("/images/gcash-receiver-qr.jpg");
  assert.equal(link.href, "/images/gcash-receiver-qr.jpg");
  assert.equal(link.download, "CALIDRO-GCash-QR.jpg");
});
