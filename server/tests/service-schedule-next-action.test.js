"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");
const script = read("public/js/services-multi.js");
const calendar = read("public/js/enterprise-calendar.js");
const view = read("views/pages/services.ejs");
const styles = read("public/css/services-mobile-ux.css");
const functions = script.slice(
  script.indexOf("function formatScheduleActionDate(value)"),
  script.indexOf("function requestBookingStepNavigation(targetStep)")
);

function setupScheduleAction(selectedTimeSlot, slotAvailable = true) {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      const attributes = new Map();
      elements.set(id, {
        textContent: "", disabled: true, parentElement: null,
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: name => attributes.get(name),
        toggleAttribute: (name, force) => force ? attributes.set(name, "") : attributes.delete(name),
        hasAttribute: name => attributes.has(name),
        classList: {
          toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
          contains: name => classes.has(name),
          remove: name => classes.delete(name),
          add: name => classes.add(name)
        }
      });
    }
    return elements.get(id);
  };
  const state = {
    currentStep: 4,
    selectedDate: new Date(2026, 8, 25),
    selectedTimeSlot,
    selectedTime: selectedTimeSlot?.label || null
  };
  const navigated = [];
  const body = { appendChild(element) { element.parentElement = body; } };
  const context = {
    BookingState: state,
    document: { getElementById, body },
    window: {
      EnterpriseCalendar: {
        isProjectMode: () => false,
        getSelectedSlot: () => selectedTimeSlot,
        validateSelectedSlot: async () => {
          if (!slotAvailable) {
            state.selectedTimeSlot = null;
            state.selectedTime = null;
          }
          return slotAvailable;
        }
      }
    },
    getBookingStepIssue: () => state.selectedDate && state.selectedTimeSlot ? null : { step: 4 },
    requestBookingStepNavigation: step => { navigated.push(step); return true; },
    presentBookingStepIssue() {},
    showServiceDialog: async () => {}
  };
  vm.runInNewContext(functions, context);
  return { context, state, navigated, get: getElementById };
}

test("returning to Schedule shows the saved date and a working Review Booking button", async () => {
  const { context, navigated, get } = setupScheduleAction({ label: "8:00 AM" });
  context.syncScheduleNextAction();

  assert.match(get("scheduleNextSummary").textContent, /Sep 25, 2026 · 8:00 AM/);
  assert.equal(get("scheduleNextButton").disabled, false);
  assert.equal(get("scheduleNextAction").classList.contains("is-visible"), true);
  assert.equal(get("scheduleNextAction").classList.contains("just-became-ready"), true);
  assert.equal(get("scheduleNextAction").parentElement, context.document.body);
  assert.equal(get("scheduleNextAction").getAttribute("aria-hidden"), "false");
  assert.equal(await context.continueFromSchedule(), true);
  assert.deepEqual(navigated, [5]);
});

test("changing the date disables Review Booking until a new time is chosen", () => {
  const { context, state, get } = setupScheduleAction(null);
  state.selectedTime = null;
  context.syncScheduleNextAction();

  assert.match(get("scheduleNextSummary").textContent, /choose a start time/);
  assert.equal(get("scheduleNextButton").disabled, true);
  assert.equal(get("scheduleNextAction").classList.contains("is-visible"), false);
});

test("schedule popup hides outside the Schedule step and returns with the saved choice", () => {
  const { context, state, get } = setupScheduleAction({ label: "12:30 PM" });
  context.syncScheduleNextAction();
  state.currentStep = 5;
  context.syncScheduleNextAction();
  assert.equal(get("scheduleNextAction").classList.contains("is-visible"), false);
  assert.equal(get("scheduleNextAction").hasAttribute("inert"), true);
  assert.equal(get("scheduleNextButton").disabled, true);
  state.currentStep = 4;
  context.syncScheduleNextAction(true);
  assert.equal(get("scheduleNextAction").classList.contains("is-visible"), true);
  assert.equal(get("scheduleNextAction").hasAttribute("inert"), false);
  assert.equal(get("scheduleNextButton").disabled, false);
});

test("an unavailable saved time cannot advance to Review", async () => {
  const { context, navigated, get } = setupScheduleAction({ label: "8:00 AM" }, false);
  context.syncScheduleNextAction();

  assert.equal(await context.continueFromSchedule(), false);
  assert.deepEqual(navigated, []);
  assert.equal(get("scheduleNextButton").disabled, true);
});

test("schedule action is visible on mobile and refreshes after calendar selections", () => {
  assert.match(view, /id="scheduleNextAction"[\s\S]*?id="scheduleNextButton"[^>]*onclick="continueFromSchedule\(\)"/);
  assert.match(styles, /\.schedule-next-action\.is-visible\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(styles, /\.schedule-next-action\.just-became-ready\s*\{[^}]*animation:\s*scheduleActionPop/);
  assert.match(calendar, /window\.syncScheduleNextAction\?\.\(\)/);
  assert.match(script, /syncScheduleNextAction\(stepNumber === 4\)/);
  assert.match(script, /document\.body\.appendChild\(action\)/);
  assert.match(script, /onSelect:\s*\(\) => syncScheduleNextAction\(\)/);
});
