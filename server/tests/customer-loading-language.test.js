"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("booking and order loading overlays use English messages", () => {
  const booking = read("views/pages/services.ejs");
  const ordering = read("views/partials/cart-wizard.ejs");

  assert.equal((booking.match(/<span class="racs-title">Submitting Your Booking\.\.\.<\/span>/g) || []).length, 2);
  assert.doesNotMatch(booking, /Isinusumite ang booking/);
  assert.match(ordering, /<span class="racs-title">Processing Your Order\.\.\.<\/span>/);
});
