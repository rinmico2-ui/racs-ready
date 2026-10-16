"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const template = fs.readFileSync(path.join(__dirname, "../views/pages/admin/Reports/RevenueReports.ejs"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "../public/js/revenue-reconciliation.js"), "utf8");

function costView() {
  const element = { innerHTML: "" };
  const context = { window: {}, document: { getElementById: id => id === "profitReconciliation" ? element : null, addEventListener() {} }, Intl };
  vm.runInNewContext(script, context);
  return { render: context.window.RACSRevenueReconciliation.render, html: () => element.innerHTML,
    rows: () => Object.fromEntries([...element.innerHTML.matchAll(/<span>([^<]+)<\/span><strong>([^<]+)<\/strong>/g)]
      .map(([, label, value]) => [label, Number(value.replace(/[^0-9.-]/g, ""))])) };
}

function analytics(overrides = {}) {
  return { recognizedRevenue: 1100, serviceDirectCost: 0, orderCost: 0, posCost: 400, projectMaterialCost: 0,
    totalPartsCost: 400, approvedExpenseTotal: 1266, payrollCost: 0, operatingProfit: -566, ...overrides };
}

test("profit breakdown exposes each cost source and reconciles the reported loss without changing money", () => {
  const view = costView();
  view.render(analytics());
  const rows = view.rows();
  assert.equal(rows["Completed sales after refunds"], 1100);
  assert.equal(rows["Less walk-in / POS product costs"], -400);
  assert.equal(rows["Less approved operating expenses"], -1266);
  assert.equal(rows["Less approved and paid payroll"], 0);
  assert.equal(rows["Total costs deducted"], 1666);
  assert.equal(rows["Profit after expenses"], -566);
  const deductions = Object.entries(rows).filter(([label]) => label.startsWith("Less ")).reduce((sum, [, value]) => sum + value, 0);
  assert.equal(rows["Completed sales after refunds"] + deductions, rows["Profit after expenses"]);
});

test("payroll is separate from operating expenses and refresh replaces old costs", () => {
  const view = costView();
  view.render(analytics({ posCost: 0, totalPartsCost: 0, approvedExpenseTotal: 0, payrollCost: 1666 }));
  assert.equal(view.rows()["Less approved operating expenses"], 0);
  assert.equal(view.rows()["Less approved and paid payroll"], -1666);
  assert.equal(view.rows()["Profit after expenses"], -566);
  view.render(analytics({ posCost: 0, totalPartsCost: 0, approvedExpenseTotal: 0, payrollCost: 0, operatingProfit: 1100 }));
  assert.equal(view.rows()["Total costs deducted"], 0);
  assert.equal(view.rows()["Profit after expenses"], 1100);
  assert.doesNotMatch(view.html(), /1,666/);
});

test("profit rows use the report reconciliation and still render without unrelated activity metadata", () => {
  const view = costView();
  const reconciliation = { netSales: 1000, savedDirectCosts: 400, approvedExpenses: 1266, payroll: 0, operatingProfit: -666, cashBreakdown: [] };
  view.render(analytics({ reconciliation, salesView: {} }));
  assert.equal(view.rows()["Completed sales after refunds"], 1000);
  assert.equal(view.rows()["Profit after expenses"], -666);
  view.render({ reconciliation: { ...reconciliation, savedDirectCosts: 200, approvedExpenses: 0, payroll: 0, operatingProfit: 800 } });
  assert.equal(view.rows()["Less saved job and product costs"], -200);
  assert.equal(view.rows()["Total costs deducted"], 200);
  assert.equal(view.rows()["Profit after expenses"], 800);
});

function navigation(hash = "") {
  const ids = ["section-executive", "section-performance", "section-collection", "section-cost", "section-service-profit", "section-pos", "section-activity"];
  const makeNode = id => ({ id, hidden: false, scrolled: 0, classList: { add() {}, toggle() {} }, scrollIntoView() { this.scrolled++; } });
  const nodes = new Map(), windowEvents = {}, buttons = ids.map(id => ({ dataset: { target: id }, attributes: {}, events: {}, classList: { toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(event, callback) { this.events[event] = callback; }, focus() {}, click() { this.events.click(); } }));
  const panels = ids.flatMap(id => [makeNode(id), makeNode(id === "section-cost" ? "profitReconciliation" : id + "-content")]);
  panels.forEach((node, index) => { node.nextElementSibling = panels[index + 1] || null; nodes.set(node.id, node); });
  nodes.set("reportNav", { querySelectorAll: () => buttons });
  nodes.set("kpiGrid", { insertAdjacentElement() {} });
  const window = { location: { hash }, setTimeout: callback => callback(), requestAnimationFrame: callback => callback(),
    addEventListener(event, callback) { windowEvents[event] = callback; }, dispatchEvent() {} };
  const document = { readyState: "complete", getElementById: id => nodes.get(id) };
  const context = { document, window, Event, history: { replaceState(a, b, value) { window.location.hash = value; } } };
  const start = template.indexOf("function setupReportNav()"), end = template.indexOf("</script>", start);
  vm.runInNewContext(template.slice(start, end), context);
  return { nodes, buttons, windowEvents, window, activate(event, newHash) { window.location.hash = newHash; windowEvents[event](); } };
}

test("opening the cost URL directly reveals and scrolls to the cost section", () => {
  const nav = navigation("#section-cost");
  assert.equal(nav.nodes.get("profitReconciliation").hidden, false);
  assert.equal(nav.nodes.get("section-executive").hidden, true);
  assert.equal(nav.nodes.get("section-cost").scrolled, 1);
  assert.equal(nav.buttons.find(button => button.dataset.target === "section-cost").attributes["aria-selected"], "true");
});

test("same-page cost anchors and browser history select the actual visible tab", () => {
  const nav = navigation();
  assert.equal(nav.nodes.get("profitReconciliation").hidden, true);
  nav.activate("hashchange", "#section-cost");
  assert.equal(nav.nodes.get("profitReconciliation").hidden, false);
  nav.activate("hashchange", "#section-performance");
  assert.equal(nav.nodes.get("profitReconciliation").hidden, true);
  nav.activate("popstate", "#section-cost");
  assert.equal(nav.nodes.get("profitReconciliation").hidden, false);
  nav.activate("hashchange", "#invalid-section");
  assert.equal(nav.nodes.get("section-executive").hidden, false);
});

test("clicking Profit and cost reveals its content and scrolls past the KPI cards", () => {
  const nav = navigation();
  nav.buttons.find(button => button.dataset.target === "section-cost").click();
  assert.equal(nav.window.location.hash, "#section-cost");
  assert.equal(nav.nodes.get("profitReconciliation").hidden, false);
  assert.equal(nav.nodes.get("section-cost").scrolled, 1);
});

test("an unavailable chart library cannot prevent numeric reporting from loading", () => {
  const canvas = {}, children = [], container = { querySelectorAll: () => [canvas], querySelector: () => children[0], appendChild: child => children.push(child) };
  const document = { querySelectorAll: () => [container], createElement: () => ({}) };
  const start = template.indexOf("  function updateCharts(A)"), end = template.indexOf("  function renderSparklines(A)", start);
  const context = { document };
  vm.runInNewContext(template.slice(start, end) + "\nupdateCharts({});updateCharts({});", context);
  assert.equal(canvas.hidden, true); assert.equal(children.length, 1);
  assert.match(children[0].textContent, /Report totals and tables are still available/);
  const sparkEnd = template.indexOf("  let currentA = initA", end);
  assert.doesNotThrow(() => vm.runInNewContext(template.slice(end, sparkEnd) + "\nrenderSparklines({monthlyRevenue:{October:{recognized:1100}}});", {}));
});
