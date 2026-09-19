"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const template = path.join(__dirname, "../views/pages/my-orders.ejs");

test("customer order history renders safely with no orders", async () => {
  const html = await ejs.renderFile(template, { orders: [] });

  assert.match(html, /No Orders Yet/);
});

test("customer order history derives payment guidance inside each order scope", async () => {
  const html = await ejs.renderFile(template, {
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
