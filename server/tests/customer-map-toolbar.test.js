"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const root = path.join(__dirname, "..");
const toolbars = [
  { name: "cart", file: "views/partials/cart-wizard.ejs", toolbar: ".checkout-map-toolbar", button: ".checkout-map-action" },
  { name: "service", file: "views/pages/services.ejs", toolbar: ".service-map-toolbar", button: ".service-map-action" },
  { name: "direct product", file: "views/partials/aircons.ejs", toolbar: ".product-map-toolbar", button: ".product-map-toolbar .product-map-action" },
];

function declarations(source, selector) {
  const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(match => match[1].trim() === selector);
  assert.ok(rule, `missing CSS rule: ${selector}`);
  return Object.fromEntries(rule[2].split(";").filter(part => part.includes(":"))
    .map(part => { const colon = part.indexOf(":"); return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]; }));
}

function contrast(first, second) {
  function luminance(hex) {
    let value = hex.replace("#", "");
    if (value.length === 3) value = [...value].map(channel => channel + channel).join("");
    const rgb = value.match(/../g).map(channel => parseInt(channel, 16) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  }
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

for (const config of toolbars) {
  const source = fs.readFileSync(path.join(root, config.file), "utf8");
  test(`${config.name} map has a colored toolbar and contrasting filled buttons`, () => {
    const toolbar = declarations(source, config.toolbar);
    assert.equal(toolbar.background, "linear-gradient(135deg,#eff6ff,#dbeafe)");
    const button = declarations(source, config.button);
    assert.equal(button.background, "#1d4ed8");
    assert.equal(button.color, "#fff");
    assert.ok(contrast(button.background, button.color) >= 4.5);
    const hover = declarations(source, `${config.button}:hover:not(:disabled)`);
    assert.equal(hover.background, "#1e40af");
    assert.ok(contrast(hover.background, hover.color) >= 4.5);
  });

  test(`${config.name} map retains visible keyboard focus and distinct disabled buttons`, () => {
    const focus = declarations(source, `${config.button}:focus-visible`);
    assert.equal(focus.outline, "3px solid #1d4ed8");
    assert.equal(focus["outline-offset"], "3px");
    const disabled = declarations(source, `${config.button}:disabled`);
    assert.equal(disabled.cursor, "not-allowed");
    assert.equal(disabled.opacity, "1");
    assert.equal(disabled.background, "#e2e8f0");
    assert.ok(contrast(disabled.background, disabled.color) >= 4.5);
    for (const background of ["#eff6ff", "#dbeafe"]) {
      assert.ok(contrast(background, "#475569") >= 4.5, "toolbar hint remains readable");
    }
  });
}

test("all checkout map toolbars render with their existing actions and route readiness intact", async () => {
  const user = { _id: "64b000000000000000000001", phone: "09171234567", name: "Test Customer" };
  const cart = await ejs.renderFile(path.join(root, toolbars[0].file), { user, cart: { items: [], totalAmount: 0 } });
  assert.match(cart, /class="checkout-map-action" id="locateMeBtn"[^>]*onclick="locateMe\(\)"/);
  assert.match(cart, /id="fitRouteBtn"[^>]*onclick="fitDeliveryRoute\(\)"[^>]*disabled/);
  assert.match(cart, /id="expandMapBtn"[^>]*onclick="toggleCheckoutMapSize\(\)"/);

  const service = await ejs.renderFile(path.join(root, toolbars[1].file), {
    user, adminGcashNumber: "", technicianLocation: null, googleMapsApiKey: "",
  });
  for (const id of ["locateCustomerBtn", "locateCompanyBtn", "focusCustomerBtn", "expandServiceMapBtn"]) {
    assert.match(service, new RegExp(`class="service-map-action" id="${id}"`));
  }
  assert.match(service, /id="fitServiceRouteBtn"[^>]*disabled/);

  const product = await ejs.renderFile(path.join(root, toolbars[2].file), { user, grouped: [] });
  assert.match(product, /class="product-map-toolbar mb-2"/);
  assert.match(product, /class="product-map-action" onclick="locateMe\(\)"/);
});
