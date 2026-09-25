"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../public/js/services-multi.js"), "utf8").replace(/\r\n/g, "\n");
const view = fs.readFileSync(path.join(__dirname, "../views/pages/services.ejs"), "utf8");
const helper = script.slice(
  script.indexOf("function isRepairBookingService(service)"),
  script.indexOf("// ── localStorage persistence")
);
const review = script.slice(
  script.indexOf("function displayTotalFee()"),
  script.indexOf("/**\n * Initialize Payment Step")
);

function renderReview(selectedServices, travelFare = 45) {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) {
      const classes = new Set(["d-none"]);
      elements.set(id, {
        textContent: "",
        innerHTML: "",
        classList: {
          add: name => classes.add(name),
          remove: name => classes.delete(name),
          toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
          contains: name => classes.has(name)
        },
        remove() {},
        closest: () => null
      });
    }
    return elements.get(id);
  };
  const state = {
    selectedServices,
    travelFare,
    fare: 90,
    customerLocation: { address: "San Leonardo, Nueva Ecija" },
    distance: 1.5,
    travelDuration: 25,
    selectedDate: "2026-09-25",
    selectedTime: "8:00 AM"
  };
  const context = {
    BookingState: state,
    document: { getElementById },
    getProjectReviewInfo: () => ({ isProject: false }),
    window: {},
    console: { log() {}, error() {} }
  };
  vm.runInNewContext(`${helper}\n${review}\ndisplayTotalFee();`, context);
  return { state, get: getElementById };
}

test("review shows a repair-only booking as an inspection fee, never a core service", () => {
  const { state, get } = renderReview([{
    name: "Midea Split Type Aircon", type: "repairServices", quantity: 1,
    unitPrice: 500, brand: "Midea", unitType: "Split Type", problemDescription: "Not cooling"
  }]);

  assert.match(get("feeServiceDetails").innerHTML, /Repair inspection/);
  assert.doesNotMatch(get("feeServiceDetails").innerHTML, /CORE/);
  assert.match(get("feeServiceDetails").innerHTML, /Problem: Not cooling/);
  assert.equal(get("repairInspectionTotalDisplay").textContent, "₱500");
  assert.equal(get("totalFeeDisplay").textContent, "₱545");
  assert.equal(get("mobileReviewTotalDisplay").textContent, "₱545");
  assert.equal(get("mobileReviewTotalLabel").textContent, "Before repair quote");
  assert.equal(state.totalFee, 545);
  assert.equal(get("servicesSubtotalRow").classList.contains("d-none"), true);
  assert.equal(get("repairInspectionRow").classList.contains("d-none"), false);
  assert.equal(get("repairQuotationNote").classList.contains("d-none"), false);
});

test("review separates service prices and inspection fees in a mixed booking", () => {
  const { state, get } = renderReview([
    { name: "Aircon Installation", type: "core", quantity: 1, unitPrice: 1000, hp: 0.5, airconTypeName: "Split Type" },
    { name: "Aircon Repair", type: "repair", quantity: 2, unitPrice: 500, initialCost: 500 }
  ]);

  assert.equal(get("servicesTotalDisplay").textContent, "₱1,000");
  assert.equal(get("repairInspectionTotalDisplay").textContent, "₱1,000");
  assert.equal(get("totalFeeDisplay").textContent, "₱2,045");
  assert.equal(get("feeServiceCount").textContent, "2 services · 3 units");
  assert.equal(get("servicesSubtotalRow").classList.contains("d-none"), false);
  assert.equal(state.servicesTotal, 2000);
});

test("review respects a confirmed zero travel fee and escapes customer-entered repair details", () => {
  const { state, get } = renderReview([{
    name: "Repair", type: "repair", quantity: 1, unitPrice: 500,
    problemDescription: "<script>alert(1)</script>"
  }], 0);
  assert.equal(get("travelFareDisplay").textContent, "₱0");
  assert.equal(get("totalFeeDisplay").textContent, "₱500");
  assert.doesNotMatch(get("feeServiceDetails").innerHTML, /<script>/);
});

test("review markup names the fee types and uses simple English", () => {
  assert.match(view, /id="repairInspectionRow"[^>]*>[\s\S]*?Repair inspection fee/);
  assert.match(view, /id="servicesSubtotalRow"[^>]*>[\s\S]*?Service price/);
  assert.match(view, /<span>Travel route<\/span>/);
  assert.doesNotMatch(view, /Review at Bayarin|<span>Ruta<\/span>/);
});
