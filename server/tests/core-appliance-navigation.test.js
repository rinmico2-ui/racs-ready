'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/core-appliance-booking.js'), 'utf8');
function fixture() {
  const start = source.indexOf("    host.addEventListener('click', event => {"), end = source.indexOf("    const submit = event => {", start);
  assert.ok(start >= 0 && end > start);
  let click;
  const changes = [];
  const host = { addEventListener(name, handler) { assert.equal(name, 'click'); click = handler; }, contains(node) { return node.owned === true; } };
  vm.runInNewContext(source.slice(start, end), { host, step: 3, setStep: step => changes.push(step), detailsValid: () => true,
    next: () => changes.push('next'), hooks: {}, reset() {} });
  // The actual booking page wraps the form in .booking-step[data-step="2"].
  const outer = { dataset: { step: '2' } };
  function target(button) {
    return { closest(selector) {
      if (selector === '[data-step]') return button || outer;
      if (selector === '.cab-progress button[data-step]') return button || null;
      if (selector === '[data-next]' && button?.next) return button;
      return null;
    } };
  }
  return { changes, click: button => click({ target: target(button) }) };
}
test('clicking brand, model, quantity or service fields does not navigate to the outer booking step', () => {
  const f = fixture();
  for (const name of ['brand', 'model', 'quantity', 'service']) { f.click(); assert.deepEqual(f.changes, [], `${name} must retain its input focus and current step`); }
});
test('the wizard still navigates from its own progress buttons, including clicks on their inner label', () => {
  const f = fixture(); f.click({ owned: true, disabled: false, dataset: { step: '2' } }); assert.deepEqual(f.changes, [2]);
});
test('disabled or unrelated progress controls cannot change this form', () => {
  const f = fixture(); f.click({ owned: true, disabled: true, dataset: { step: '3' } }); f.click({ owned: false, dataset: { step: '1' } }); assert.deepEqual(f.changes, []);
});
test('Next does not also navigate backward because of the outer booking container', () => {
  const f = fixture(); f.click({ next: true }); assert.deepEqual(f.changes, ['next']);
});
