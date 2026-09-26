"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

test("customer pickup hours group matching weekdays and show changed hours separately", () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read("../public/js/customer-store-hours.js"), sandbox);
  const format = sandbox.window.CustomerStoreHours.format;
  const weekdayHours = [1, 2, 3, 4, 5].map(dayOfWeek => ({ dayOfWeek, open: true, startMinutes: 480, endMinutes: 1080 }));
  const hours = [
    { dayOfWeek: 0, open: false, startMinutes: 0, endMinutes: 0 },
    ...weekdayHours,
    { dayOfWeek: 6, open: true, startMinutes: 540, endMinutes: 1020 },
  ];
  assert.equal(format(hours), "Mon–Fri · 8:00 AM–6:00 PM; Sat · 9:00 AM–5:00 PM");
  assert.match(format([]), /No store pickup hours/);
});

test("service and product checkout show configured hours beside scheduling", () => {
  const routes = read("../routes/pages.js");
  const service = read("../views/pages/services.ejs");
  const direct = read("../views/partials/aircons.ejs");
  const cart = read("../views/partials/cart-wizard.ejs");
  const note = read("../views/partials/customer-hours-note.ejs");
  for (const file of [service, direct, cart, note]) ejs.compile(file);
  const serviceNote = ejs.render("<%- include('../partials/customer-hours-note', { hoursLabel: 'Service team hours', hoursSummary: 'Mon–Sat · 8:00 AM–6:00 PM', hoursNote: 'Choose an available slot.' }) %>", {}, { filename: path.join(__dirname, "../views/pages/services.ejs") });
  const productNote = ejs.render("<%- include('customer-hours-note', { hoursLabel: 'Delivery and installation hours', hoursSummary: 'Mon–Sat · 8:00 AM–6:00 PM', hoursNote: 'Choose an available slot.' }) %>", {}, { filename: path.join(__dirname, "../views/partials/aircons.ejs") });
  assert.match(serviceNote, /Service team hours: Mon–Sat/);
  assert.match(productNote, /Delivery and installation hours: Mon–Sat/);
  assert.match(routes, /businessHours: await getBusinessHours\(\)/);
  assert.match(service, /hoursLabel: 'Service team hours'/);
  assert.match(direct, /hoursLabel: 'Delivery and installation hours'/);
  assert.match(cart, /hoursLabel: 'Delivery and installation hours'/);
  assert.match(direct, /directStoreHoursInfo/);
  assert.match(cart, /storeHoursInfo/);
  assert.match(cart, /CustomerStoreHours\.load\(\)/);
});
