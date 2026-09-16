"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  detectIntent,
  extractIntroducedName,
} = require("../utils/chatIntent");

test("short Filipino introductions are conversational, not pricing queries", () => {
  assert.equal(detectIntent("ako si ato")[0], "introduction");
  assert.equal(extractIntroducedName("ako si ato"), "Ato");
  assert.notEqual(detectIntent("ako si ato")[0], "pricing");
});

test("intent detection requires whole phrases and preserves real customer requests", () => {
  assert.equal(detectIntent("How much is aircon installation?")[0], "pricing");
  assert.equal(detectIntent("My name is Maria Santos")[0], "introduction");
  assert.equal(detectIntent("I need warranty coverage")[0], "warranty");
  assert.equal(detectIntent("yes please")[0], "yes");
  assert.equal(detectIntent("si ato")[0], "unknown");
});
