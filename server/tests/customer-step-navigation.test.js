"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const servicesView = fs.readFileSync(
  path.join(__dirname, "../views/pages/services.ejs"),
  "utf8",
);
const servicesScript = fs.readFileSync(
  path.join(__dirname, "../public/js/services-multi.js"),
  "utf8",
);
const cartWizardPath = path.join(__dirname, "../views/partials/cart-wizard.ejs");
const cartWizardSource = fs.readFileSync(cartWizardPath, "utf8");

test("service progress navigation reports the first incomplete prerequisite", () => {
  assert.match(servicesView, /requestBookingStepNavigation\(step\)/);
  assert.match(servicesView, /data-authenticated="<%= user \? 'true' : 'false' %>"/);
  assert.match(servicesScript, /function getBookingStepIssue/);
  assert.match(
    servicesScript,
    /for \(let prerequisiteStep = 1; prerequisiteStep < step; prerequisiteStep \+= 1\)/,
  );
  assert.match(servicesScript, /title: 'Select a Service First'/);
  assert.match(servicesScript, /title: 'Confirm Your Service Location'/);
  assert.match(servicesScript, /title: 'Choose a Date and Time'/);
  assert.match(servicesView, /id="continueToNextStep" aria-describedby="continueHint"/);
  assert.doesNotMatch(servicesScript, /alert\('Please select at least one service first'\)/);
});

test("every navigation path into the services step prepares the catalog", () => {
  assert.match(servicesScript, /function prepareServiceSelectionStep\(\)/);
  assert.match(
    servicesScript,
    /if \(stepNumber === 2\) \{\s*prepareServiceSelectionStep\(\);\s*\}/,
  );
  assert.match(
    servicesScript,
    /if \(step === currentStep\) \{\s*if \(step === 2\) prepareServiceSelectionStep\(\);/,
  );
  assert.match(servicesScript, /function continueToServices\(\) \{\s*\/\/ Move to Step 2\s*showStep\(2\);\s*\}/);
});

test("order progress navigation is keyboard accessible and cannot skip steps", async () => {
  const html = await ejs.renderFile(cartWizardPath, {
    cart: { items: [], totalAmount: 0 },
    user: { phone: "09171234567" },
  });

  assert.match(html, /<button type="button" class="wizard-ps active"/);
  assert.match(html, /role="button" tabindex="0" aria-pressed="false"/);
  assert.match(cartWizardSource, /function getCheckoutStepIssue/);
  assert.match(cartWizardSource, /async function validateCheckoutStep/);
  assert.match(
    cartWizardSource,
    /for \(let prerequisiteStep = 1; prerequisiteStep < step; prerequisiteStep \+= 1\)/,
  );
  assert.match(cartWizardSource, /document\.getElementById\('wizardTimeSlot'\)\.value/);
  assert.doesNotMatch(cartWizardSource, /Please complete the current step first\./);

  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  for (const script of inlineScripts) {
    assert.doesNotThrow(() => new Function(script));
  }
});
