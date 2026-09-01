const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");

const BookingService = require("../models/BookingService");
const pageRoutes = require("../routes/pages");

test("public no-show reschedule uses a private action layout", async (t) => {
  t.mock.method(BookingService, "findOne", () => ({
    async lean() { return null; },
  }));

  const layer = pageRoutes.stack.find(
    (candidate) =>
      candidate.route &&
      candidate.route.path === "/reschedule/no-show/:token" &&
      candidate.route.methods.get,
  );
  assert.ok(layer, "expected the public reschedule route");

  const headers = {};
  let rendered;
  const req = { params: { token: "invalid-test-token" } };
  const res = {
    set(name, value) { headers[name] = value; },
    render(view, options) { rendered = { view, options }; },
  };

  await layer.route.stack.at(-1).handle(req, res);

  assert.equal(headers["Cache-Control"], "no-store, private");
  assert.equal(rendered.view, "pages/noShowReschedule");
  assert.equal(rendered.options.layout, "layouts/public-action");
});

test("the public action layout contains no site navigation or footer", async () => {
  const filename = path.join(
    __dirname,
    "..",
    "views",
    "layouts",
    "public-action.ejs",
  );
  const html = await ejs.renderFile(filename, {
    title: "Reschedule Service",
    body: '<section id="calendarGrid"></section>',
  });

  assert.match(html, /noindex, nofollow, noarchive/);
  assert.match(html, /id="calendarGrid"/);
  assert.doesNotMatch(html, /<nav\b/i);
  assert.doesNotMatch(html, /<footer\b/i);
  assert.doesNotMatch(html, />\s*Sign In\s*</i);
});
