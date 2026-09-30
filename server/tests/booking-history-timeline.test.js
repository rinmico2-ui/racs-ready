"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ejs = require("ejs");
const viewPath = path.join(__dirname, "../views/pages/book-history.ejs");
const view = fs.readFileSync(viewPath, "utf8");
const client = fs.readFileSync(path.join(__dirname, "../public/js/book-history.js"), "utf8");
const mobileStart = view.indexOf("@media (max-width: 767.98px)", view.indexOf("#bhDetailModal .bh-timeline {"));
const mobileEnd = view.indexOf("@media (max-width: 575.98px)", mobileStart);

function rule(source, selector) {
  const found = [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(match => match[1].trim() === selector);
  assert.ok(found, `missing rule: ${selector}`);
  return found[2];
}

test("desktop booking timeline fits all steps without its own scroll container", () => {
  const desktop = view.slice(view.indexOf("#bhDetailModal .bh-timeline {"), mobileStart);
  const timeline = rule(desktop, "#bhDetailModal .bh-timeline");
  assert.match(timeline, /display:\s*grid/);
  assert.match(timeline, /grid-auto-flow:\s*column/);
  assert.match(timeline, /grid-auto-columns:\s*minmax\(0, 1fr\)/);
  assert.match(timeline, /overflow:\s*visible/);
  assert.doesNotMatch(timeline, /overflow-[xy]:\s*(auto|scroll)|overflow:\s*hidden/);
  assert.match(rule(desktop, "#bhDetailModal .bh-timeline-step"), /min-width:\s*0/);
  assert.match(rule(desktop, "#bhDetailModal .bh-timeline-label"), /overflow-wrap:\s*anywhere/);
});

test("narrow screens stack readable steps and connecting lines vertically", () => {
  const mobile = view.slice(mobileStart, mobileEnd);
  assert.match(mobile, /grid-auto-flow:\s*row/);
  assert.match(mobile, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(rule(mobile, "#bhDetailModal .bh-timeline-step"), /flex-direction:\s*row/);
  assert.match(rule(mobile, "#bhDetailModal .bh-timeline-step:not(:last-child)::after"), /width:\s*2px;\s*height:\s*100%/);
  assert.match(rule(mobile, "#bhDetailModal .bh-timeline-label"), /text-align:\s*left/);
  assert.doesNotMatch(view, /\.bh-timeline-step\s*\{[^}]*min-width:\s*(58|68)px/);
  assert.match(rule(view, "#bhDetailModal .bh-modal-body"), /overflow-y:\s*auto/);
});

test("core and repair timelines retain every stage and current/completed highlighting", () => {
  const start = client.indexOf("    const timelineSteps = isRepair");
  const end = client.indexOf("    // Hero", start);
  assert.ok(start >= 0 && end > start);
  for (const [isRepair, status, expectedCount, doneCount, currentLabel] of [
    [false, "assigned", 7, 2, "Assigned"],
    [false, "completed", 7, 6, "Completed"],
    [true, "repair_in_progress", 6, 4, "Repair"],
  ]) {
    const html = vm.runInNewContext(`${client.slice(start, end)}\ntimelineHtml;`, {
      isRepair, status, escapeHtml: value => value,
    });
    assert.equal((html.match(/class="bh-timeline-step /g) || []).length, expectedCount);
    assert.equal((html.match(/bh-timeline--done/g) || []).length, doneCount);
    assert.equal((html.match(/bh-timeline--current/g) || []).length, 1);
    assert.match(html, new RegExp(`bh-timeline--current[^]*?bh-timeline-label">${currentLabel}<`));
    assert.match(html, /bh-timeline-label">Completed</);
  }
});

test("booking history template still renders the accessible detail modal", async () => {
  const html = await ejs.renderFile(viewPath, { user: { _id: "customer-a", email: "test@example.test" } });
  assert.match(html, /id="bhDetailModal" tabindex="-1"/);
  assert.match(html, /class="bh-modal-body" id="bh-modal-body"/);
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) assert.doesNotThrow(() => new vm.Script(match[1]));
  }
});
