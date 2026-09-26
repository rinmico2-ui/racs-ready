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

test("service progress makes completed steps obvious back-navigation targets", () => {
  assert.equal((servicesView.match(/data-step-label="/g) || []).length, 6);
  assert.match(servicesView, /Need to go back\?[\s\S]*?Select any green completed step/);
  assert.match(servicesView, /j!==i&&j<maxLogicalStep/);
  assert.match(servicesView, /\(j<i\?'Go back to ':'Return to '\)\+label/);
  assert.match(servicesView, /setAttribute\('aria-disabled','true'\)/);
  assert.match(servicesView, /trigger&&trigger\.classList\.contains\('inactive'\)/);
  assert.match(servicesView, /\.ent-n\.completed:hover\{[^}]*background:#dcfce7/);
  assert.match(servicesView, /\.ent-n\.inactive\{cursor:not-allowed;opacity:\.58\}/);
  assert.match(servicesView, /onclick="navigateToStep\(2,this\)"/);
});

test("every forward path is guarded and the sticky progress panel owns an obvious Back button", () => {
  const showStep = servicesScript.slice(
    servicesScript.indexOf("function showStep(stepNumber)"),
    servicesScript.indexOf("function setupStepProgression(stepNumber)"),
  );

  assert.match(showStep, /if \(requestedStep > prevStep && typeof getBookingStepIssue === 'function'\)/);
  assert.match(showStep, /for \(let prerequisiteStep = 1; prerequisiteStep < requestedStep; prerequisiteStep \+= 1\)/);
  assert.match(showStep, /presentBookingStepIssue\(issue\);\s*return false/);
  assert.match(showStep, /Navigation is non-destructive/);
  assert.doesNotMatch(showStep, /BookingState\.customerLocation = null/);
  assert.doesNotMatch(showStep, /BookingState\.selectedDate = null/);
  assert.equal((servicesView.match(/id="bookingStepperBack"/g) || []).length, 1);
  for (const label of ["Service Selection", "Services & Details", "Service Location", "Schedule", "Review Booking"]) {
    assert.match(servicesView, new RegExp(`label:'${label.replace("&", "&")}'`));
  }
  assert.match(servicesView, /class="ent-h-controls"[\s\S]*?class="booking-stepper-back" id="bookingStepperBack"/);
  assert.match(servicesView, /\.booking-stepper-back\{[^}]*display:inline-flex[^}]*border:1px solid #cbd5e1[^}]*box-shadow:none/);
  assert.match(servicesView, /\.booking-stepper-back-icon\{[^}]*background:#e2e8f0/);
  assert.match(servicesView, /b\.hidden=false;\s*b\.disabled=!previous;/);
  assert.match(servicesView, /b\.classList\.toggle\('is-visible',true\)/);
  assert.match(servicesView, /Back is unavailable on the first step/);
  assert.doesNotMatch(servicesView, /document\.body\.appendChild\(b\)/);
  assert.match(servicesView, /function goBackOneBookingStep\(\)/);
  assert.match(servicesView, /b\.dataset\.targetStep=String\(previous\.step\)/);
  assert.match(servicesScript, /requestBookingStepNavigation\(4\)/);
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
