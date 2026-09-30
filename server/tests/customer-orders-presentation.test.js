"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const historyTemplate = path.join(__dirname, "../views/pages/my-orders.ejs");
const detailTemplate = path.join(__dirname, "../views/pages/order-details.ejs");

test("customer order history renders safely with no orders", async () => {
  const html = await ejs.renderFile(historyTemplate, { orders: [] });

  assert.match(html, /No Orders Yet/);
});

test("customer order history derives payment guidance inside each order scope", async () => {
  const html = await ejs.renderFile(historyTemplate, {
    orders: [{
      _id: "order-1",
      orderReference: "ORD-001",
      createdAt: new Date("2026-09-19T00:00:00.000Z"),
      status: "pending_payment",
      paymentChannel: "card",
      paymentMethod: "cod",
      paymentStatus: "pending",
      fulfillmentType: "delivery_installation",
      items: [],
      total: 0,
    }],
  });

  assert.match(html, /ORD-001/);
  assert.match(html, /Pay by credit or debit card at the RACS store/);
});

test("customer order history names full payment correctly without relabeling actual downpayments", async () => {
  const base = {
    createdAt: new Date("2026-09-19T00:00:00.000Z"), status: "pending_payment",
    paymentStatus: "pending", fulfillmentType: "delivery_installation", items: [], total: 27747,
  };
  const html = await ejs.renderFile(historyTemplate, { orders: [
    { ...base, _id: "full-order", orderReference: "ORD-FULL", paymentMethod: "gcash_full",
      downpaymentPercentage: 100, downpaymentAmount: 27747, balanceAmount: 0 },
    { ...base, _id: "partial-order", orderReference: "ORD-PARTIAL", paymentMethod: "cod",
      downpaymentPercentage: 10, downpaymentAmount: 2774.7, balanceAmount: 24972.3 },
  ] });
  assert.match(html, /<strong>Full payment:<\/strong>\s*&#8369;27,747\s*&middot;\s*<strong>Remaining:<\/strong>\s*&#8369;0/);
  assert.match(html, /<strong>10% downpayment:<\/strong>/);
  assert.doesNotMatch(html, /100% downpayment:/);
});

test("customer order detail excludes installation from the payable total", async () => {
  const html = await ejs.renderFile(detailTemplate, {
    order: {
      _id: "order-1",
      orderReference: "ORD-001",
      createdAt: new Date("2026-09-19T00:00:00.000Z"),
      status: "pending_payment",
      paymentChannel: "gcash",
      paymentMethod: "gcash_full",
      paymentStatus: "pending",
      fulfillmentType: "delivery_installation",
      items: [{
        brand: "Carrier",
        modelLine: "XPOWERGOLD3 Inverter",
        capacity: 1,
        capacityUnit: "HP",
        quantity: 1,
        unitPrice: 25500,
        totalPrice: 25500,
      }],
      subtotal: 25500,
      installationFee: 1500,
      transportationFee: 2247,
      total: 29247,
      downpaymentAmount: 29247,
      balanceAmount: 0,
      customer: { name: "Test Customer", phone: "09530000000" },
      delivery: {
        address: "Test Address",
        preferredDate: new Date("2026-09-20T00:00:00.000Z"),
      },
      timeSlot: "8:00 AM",
      statusHistory: [],
    },
  });

  assert.match(html, /Aircon product price[\s\S]*?25,500\.00/);
  assert.match(html, /Installation service[\s\S]*?not included[\s\S]*?1,500\.00/);
  assert.match(html, /Transportation service[\s\S]*?2,247\.00/);
  assert.match(html, /Full payment[\s\S]*?27,747\.00/);
  assert.match(html, /Total payable[\s\S]*?27,747\.00/);
  assert.doesNotMatch(html, /29,247\.00/);
  assert.match(html, /total payable includes only the aircon products and transportation/i);
});
