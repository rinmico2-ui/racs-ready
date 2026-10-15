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
  assert.equal(detectIntent("How much for aircon cleaning, repair and installation?")[0], "pricing");
  assert.equal(detectIntent("Magkano ang pagkakabit ng aircon?")[0], "pricing");
  assert.equal(detectIntent("What is the cost of refrigerator repair?")[0], "pricing");
  assert.equal(detectIntent("What's the price of aircon installation?")[0], "pricing");
  assert.equal(detectIntent("Can you repair my refrigerator?")[0], "services");
  assert.equal(detectIntent("My name is Maria Santos")[0], "introduction");
  assert.equal(detectIntent("I need warranty coverage")[0], "warranty");
  assert.equal(detectIntent("yes please")[0], "yes");
  assert.equal(detectIntent("si ato")[0], "unknown");
});
