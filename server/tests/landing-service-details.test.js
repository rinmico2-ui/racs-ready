"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ejs = require("ejs");
const views = path.join(__dirname, "../views");
const names = ["Aircon Installation", "Aircon Cleaning", "Freon Recharging", "Aircon Relocation", "Refrigerator Repair", "Washing Machine", "Microwave Oven", "Water Dispenser"];

function pageData(user) {
  return {
    title: "CALIDRO RACS", user, lightweightPublicPage: true, showLandingChatbot: false,
    companyName: "CALIDRO RACS", companyTagline: "Service", companyPhone: "123",
    companyEmail: "service@example.test", companyAddress: "Nueva Ecija",
    publicStats: {}, displayRating: 0, displayCount: 0,
    businessHours: { summary: "Mon-Sat" }, companyLocation: { lat: 15.5, lng: 121 },
  };
}

for (const user of [null, { _id: "64b000000000000000000001", role: "customer", firstName: "Test", lastName: "Customer", email: "test@example.test" }]) {
  test(`home service details have working Bootstrap targets for ${user ? "customers" : "guests"}`, async () => {
    const data = pageData(user);
    const body = await ejs.renderFile(path.join(views, "pages/landing.ejs"), data);
    const html = await ejs.renderFile(path.join(views, "layouts/main.ejs"), { ...data, body });
    const triggers = [...body.matchAll(/<button\b[^>]*class="ent-service-price ent-service-details-button"[^>]*>/g)];
    assert.equal(triggers.length, names.length);
    const modalStarts = [...body.matchAll(/<div class="modal fade landing-service-detail" id="landingServiceDetail(\d+)"/g)];
    assert.equal(modalStarts.length, names.length);
    for (let idx = 0; idx < names.length; idx++) {
      const trigger = triggers[idx][0];
      assert.match(trigger, /type="button"/);
      assert.match(trigger, /data-bs-toggle="modal"/);
      assert.match(trigger, new RegExp(`data-bs-target="#landingServiceDetail${idx}"`));
      assert.match(trigger, new RegExp(`aria-controls="landingServiceDetail${idx}"`));
      assert.match(trigger, /aria-haspopup="dialog"/);
      assert.ok(trigger.includes(`aria-label="View details for ${names[idx]}"`));
      const modal = body.slice(modalStarts[idx].index, modalStarts[idx + 1]?.index ?? body.indexOf("SECTION 6:", modalStarts[idx].index));
      assert.match(modal, new RegExp(`aria-labelledby="landingServiceDetailTitle${idx}"`));
      assert.match(modal, new RegExp(`id="landingServiceDetailTitle${idx}">${names[idx]}</h2>`));
      assert.match(modal, new RegExp(`aria-describedby="landingServiceDetailDescription${idx}"`));
      assert.match(modal, new RegExp(`id="landingServiceDetailDescription${idx}">[^<]{60,}</p>`));
      assert.equal((modal.match(/<li>/g) || []).length, 3);
      assert.equal((modal.match(/data-bs-dismiss="modal"/g) || []).length, 2);
      assert.match(modal, /modal-dialog-centered modal-dialog-scrollable/);
      assert.match(modal, /<a href="\/services" class="btn btn-primary">Book Now/);
      assert.match(modal, idx < 4 ? /current service options and pricing/ : /Repair requests begin with an inspection/);
    }
    assert.match(html, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.3\.2\/dist\/js\/bootstrap\.bundle\.min\.js"><\/script>/);
    assert.match(body, /landing-enterprise\.css\?v=20260929-service-details-prices-v2/);
    assert.match(body, /landing-service-prices\.js\?v=20260929-catalog-prices-v1/);
    assert.equal((body.match(/data-price-service="/g) || []).length, names.length);
    assert.doesNotMatch(body, /<span class="ent-service-price">View Details/);
  });
}

test("service modals are outside the animated cards and sections", () => {
  const view = fs.readFileSync(path.join(views, "pages/landing.ejs"), "utf8");
  const partial = fs.readFileSync(path.join(views, "partials/landing-service-details.ejs"), "utf8");
  assert.match(view, /<\/section>\s*<%# Keep dialogs[^]*?<%- include\('\.\.\/partials\/landing-service-details', \{ services \}\) %>/);
  assert.doesNotMatch(partial, /ent-reveal|ent-service-card|ent-section/);
  assert.doesNotMatch(partial, /<script|fetch\(|Starting from|30-day/);
});

test("service-detail templates escape descriptions and booking preparation text", async () => {
  const html = await ejs.renderFile(path.join(views, "partials/landing-service-details.ejs"), {
    services: [{ name: '<script>alert(1)</script>', type: "Core Service", description: '<img src=x onerror="alert(1)">', preparation: ['<svg onload="alert(1)">'] }],
  });
  assert.doesNotMatch(html, /<script|<img|<svg/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;svg/);
});

test("details buttons have a touch target and keyboard focus without changing other modals", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public/css/landing-enterprise.css"), "utf8");
  assert.match(css, /\.ent-service-details-button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.ent-service-details-button:focus-visible\s*\{[^}]*outline:\s*3px solid #2563eb/);
  assert.match(css, /\.landing-service-detail \.modal-content\s*\{/);
  assert.match(css, /\.ent-service-card:focus-within \.ent-service-overlay/);
});

test("home page still renders valid inline scripts and keeps booking links separate", async () => {
  const html = await ejs.renderFile(path.join(views, "pages/landing.ejs"), pageData(null));
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) assert.doesNotThrow(() => new vm.Script(match[1]));
  }
  assert.equal((html.match(/<a href="\/services" class="ent-btn-primary" style="padding: 10px 20px;/g) || []).length, 8);
});
