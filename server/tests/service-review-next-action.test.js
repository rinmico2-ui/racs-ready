"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const script = read("public/js/services-multi.js");
const view = read("views/pages/services.ejs");
const styles = read("public/css/services-mobile-ux.css");
const source = script.match(/function syncReviewNextAction\(highlight = false\) \{[\s\S]*?\n\}/)?.[0];

test("review total pops into the viewport and hides after moving to Payment", () => {
  assert.ok(source);
  const classes = new Set();
  const attributes = new Map();
  const action = {
    parentElement: null,
    hidden: true,
    offsetWidth: 300,
    classList: {
      contains: name => classes.has(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      add: name => classes.add(name),
      remove: name => classes.delete(name)
    },
    setAttribute: (name, value) => attributes.set(name, value),
    toggleAttribute: (name, force) => force ? attributes.set(name, "") : attributes.delete(name)
  };
  const body = { appendChild(element) { element.parentElement = body; } };
  const state = { currentStep: 5 };
  const sync = vm.runInNewContext(`(${source})`, {
    BookingState: state,
    document: { body, getElementById: id => id === "reviewNextAction" ? action : null }
  });

  sync();
  assert.equal(action.parentElement, body);
  assert.equal(classes.has("is-visible"), true);
  assert.equal(action.hidden, false);
  assert.equal(classes.has("just-became-ready"), true);
  assert.equal(attributes.get("aria-hidden"), "false");
  state.currentStep = 6;
  sync();
  assert.equal(classes.has("is-visible"), false);
  assert.equal(action.hidden, true);
  assert.equal(attributes.get("aria-hidden"), "true");
  assert.equal(attributes.has("inert"), true);
  state.currentStep = 3;
  sync();
  assert.equal(action.hidden, true, "the payment CTA stays hidden on Location");
  state.currentStep = 4;
  sync();
  assert.equal(action.hidden, true, "the payment CTA stays hidden on Schedule");
});

test("review has one guarded payment action for desktop and mobile", () => {
  const reviewStep = view.slice(view.indexOf('id="feeStep"'), view.indexOf('id="paymentStep"'));
  assert.match(reviewStep, /id="reviewNextAction"[^>]*aria-hidden="true" hidden inert[\s\S]*?id="mobileReviewTotalDisplay"[\s\S]*?onclick="requestBookingStepNavigation\(6\)"/);
  assert.doesNotMatch(reviewStep, /id="feeStepNextBtn"|onclick="showStep\(6\)/);
  assert.doesNotMatch(view, /\.booking-review-mobile-action\{position:fixed;[^}]*display:flex/);
  assert.match(script, /displayTotalFee\(\);\s*updateReviewContent\(\);\s*\}\s*syncReviewNextAction\(stepNumber === 5\)/);
  assert.match(styles, /\.booking-review-mobile-action\[hidden\] \{ display: none !important; \}/);
  assert.match(styles, /\.booking-review-mobile-action\.is-visible\s*\{[\s\S]*?position:\s*fixed/);
});
