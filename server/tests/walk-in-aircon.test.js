const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ejs = require("ejs");

const posRoutes = require("../routes/posRoutes");
const { addMinutesToClock } = require("../utils/clockTime");

function routeLayer(router, pathValue, method) {
  return router.stack.find((layer) => layer.route
    && layer.route.path === pathValue
    && layer.route.methods[method]);
}

test("walk-in installation booking preserves 12-hour and 24-hour clock formats", () => {
  assert.equal(addMinutesToClock("1:00 PM", 60), "2:00 PM");
  assert.equal(addMinutesToClock("11:30 AM", 120), "1:30 PM");
  assert.equal(addMinutesToClock("13:30", 60), "14:30");
  assert.equal(addMinutesToClock("invalid", 60), "");
});

test("walk-in aircon has a dedicated authenticated API surface", () => {
  const router = posRoutes.walkInAirconRouter;
  assert.ok(router, "expected walk-in aircon router export");
  assert.ok(routeLayer(router, "/products", "get"));
  assert.ok(routeLayer(router, "/quote", "post"));
  assert.ok(routeLayer(router, "/checkout", "post"));

  const checkoutSource = routeLayer(router, "/checkout", "post").route.stack.at(-1).handle.toString();
  assert.match(checkoutSource, /technicianId/);
  assert.match(checkoutSource, /getTimeSlotsForQuery/);
  assert.match(checkoutSource, /BookingService/);
  assert.match(checkoutSource, /startTransaction/);
});

test("admin walk-in page exposes Services and Aircon Orders workflows", async () => {
  const filename = path.join(__dirname, "..", "views", "pages", "admin", "Appointments", "WalkIn.ejs");
  const html = await ejs.renderFile(filename, {
    user: { role: "admin" },
    airconOrdersEnabled: true,
  });

  assert.match(html, /data-walkin-mode="services"/);
  assert.match(html, /data-walkin-mode="aircon"/);
  assert.match(html, /id="waTechnician"/);
  assert.match(html, /id="waCalendar"/);
  assert.match(html, /id="waCalendarTitle"/);
  assert.match(html, /id="waTimeSlots"/);
  assert.match(html, /id="waScheduleSummary"/);
  assert.match(html, /id="waCartDrawer"/);
  assert.match(html, /id="waVariantBackdrop"/);
  assert.match(html, /mode:"all"/);
  assert.match(html, /\/api\/walk-in-aircon\/checkout/);
});

test("inventory POS no longer offers an aircon sales tab or barcode fallback", async () => {
  const filename = path.join(__dirname, "..", "views", "pages", "admin", "Inventory", "POS.ejs");
  const html = await ejs.renderFile(filename, { user: { role: "admin" } });
  assert.doesNotMatch(html, /switchTab\(['"]aircons/);

  const barcode = routeLayer(posRoutes, "/tools/barcode/:barcode", "get");
  assert.ok(barcode);
  const source = barcode.route.stack.at(-1).handle.toString();
  assert.doesNotMatch(source, /HVACProduct|Inventory\.findOne/);
  assert.match(source, /POS_MERCHANDISE_ONLY/);
});
