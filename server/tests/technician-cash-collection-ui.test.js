'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pricing = require('../public/js/repair-visit-payment');
const source = fs.readFileSync(require.resolve('../views/pages/technician/assignments.ejs'), 'utf8');
const start = source.indexOf('    let collectTargetId = null;');
const end = source.indexOf('    window.collectRepairPayment = async function', start);
assert.ok(start >= 0 && end > start);

function fixture(options = {}) {
  const elements = new Map(), requests = [], messages = [];
  const booking = { _id: 'booking', serviceType: 'core', totalPrice: 5247, travelFare: 2247, amountPaid: 0,
    services: [{ name: 'Aircon Installation', type: 'core', quantity: 1, unitPrice: 3000, totalPrice: 3000 }], ...options.booking };
  function get(id) {
    assert.doesNotMatch(id, /^collection(?:Cash)?Proof/, 'Collection no longer reads any upload fields');
    if (!elements.has(id)) {
      const classes = new Set(); let value = '';
      elements.set(id, { id, checked: false, files: [], disabled: false, required: false, open: false,
        max: '', style: {}, textContent: '', innerHTML: '', handlers: {}, focused: false,
        get value() { return value; }, set value(next) { value = String(next); if (next === '' && /Proof$/.test(id)) this.files = []; },
        classList: { add(...names) { names.forEach(n => classes.add(n)); }, remove(...names) { names.forEach(n => classes.delete(n)); },
          contains(name) { return classes.has(name); }, toggle(name, enabled) { const on = enabled ?? !classes.has(name); on ? classes.add(name) : classes.delete(name); return on; } },
        addEventListener(name, callback) { this.handlers[name] = callback; }, focus() { this.focused = true; },
      });
    }
    return elements.get(id);
  }
  const modal = { show() {}, hide() {} };
  const context = { window: { RepairVisitPayment: pricing }, document: { getElementById: get },
    bootstrap: { Modal: { getOrCreateInstance: () => modal } },
    fetch: async (url, init) => {
      if (!init?.method) return { ok: true, json: async () => ({ booking }) };
      requests.push({ url, body: JSON.parse(init.body) });
      if (options.failPayment) return { ok: false, json: async () => ({ error: 'Refresh this booking before collecting.' }) };
      return { ok: true, json: async () => ({ paymentStatus: 'waiting_for_remittance', balanceAmount: 0, amountPaid: 5247, balanceCollected: true, message: 'Payment recorded.' }) };
    },
    FileReader: class { readAsDataURL(file) { this.result = file.data; this.onload(); } },
    navigator: {}, setTimeout() {}, currentFilter: 'active', currentPage: 1, loadAssignments() {},
    showNotification(message) { messages.push(message); }, Swal: { fire() { assert.fail('The cash flow does not need another dialog.'); } },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { get, requests, messages, context, options,
    open: () => context.window.openCollectPaymentModal('assignment', { bookingId: booking, customerName: 'Abby Oseo', serviceName: 'Aircon Installation', totalPrice: 9999 }),
    method(value) { get('collectionMethod').value = value; get('collectionMethod').handlers.change(); },
    amount(value) { get('paymentAmountInput').value = value; get('paymentAmountInput').handlers.input(); },
    submit: () => get('confirmCollectBtn').handlers.click.call(get('confirmCollectBtn')),
  };
}

test('cash opens with fresh charges, no upload controls, and closed optional notes', async () => {
  const f = fixture(); await f.open();
  assert.equal(f.get('paymentTotalFee').textContent, '₱5,247');
  assert.equal(f.get('paymentCoreServiceFee').textContent, '₱3,000');
  assert.equal(f.get('paymentTravelFee').textContent, '₱2,247');
  assert.equal(f.get('paymentPartsRow').style.display, 'none');
  assert.equal(f.get('paymentLaborRow').style.display, 'none');
  assert.equal(f.get('collectionSupportingDetails').open, false);
  assert.equal(f.get('collectionCashConfirmed').checked, false);
  assert.match(f.get('collectionCashConfirmationLabel').textContent, /5,247/);
  const modal = source.slice(source.indexOf('id="collectPaymentModal"'), source.indexOf('<!-- Inspection Payment Modal -->'));
  assert.doesNotMatch(modal, /type="file"|Payment screenshot|Receipt photo|Customer Signature|Customer Confirmation Photo/);
});

test('cash requires confirmation, then submits without photos or customer signature', async () => {
  const f = fixture(); await f.open(); await f.submit();
  assert.equal(f.requests.length, 0); assert.match(f.get('paymentErrorBox').textContent, /Confirm that you received/);
  assert.equal(f.get('collectionCashConfirmed').focused, true);
  f.get('collectionCashConfirmed').checked = true; await f.submit();
  assert.equal(f.requests.length, 1);
  const { body } = f.requests[0];
  assert.equal(body.amount, 5247); assert.equal(body.method, 'cash'); assert.equal(body.cashReceivedConfirmed, true);
  assert.equal(body.proofUrl, undefined); assert.equal(body.customerSignature, undefined); assert.equal(body.customerPhotoUrl, undefined);
  assert.equal(f.messages[0].type, 'success');
});

test('changing the amount or payment method clears cash confirmation and prevents short collection', async () => {
  const f = fixture(); await f.open(); f.get('collectionCashConfirmed').checked = true;
  f.amount(100); assert.equal(f.get('collectionCashConfirmed').checked, false);
  assert.match(f.get('collectionCashConfirmationLabel').textContent, /₱100/);
  await f.submit(); assert.equal(f.requests.length, 0); assert.match(f.get('paymentErrorBox').textContent, /5,247/);
  f.amount(5247); f.get('collectionCashConfirmed').checked = true; f.method('gcash'); f.method('cash');
  assert.equal(f.get('collectionCashConfirmed').checked, false);
});

test('GCash and bank collect with a transfer reference and no photos', async () => {
  for (const method of ['gcash', 'bank']) {
    const f = fixture(); await f.open(); f.method(method);
    assert.equal(f.get('collectionCashWrap').classList.contains('d-none'), true);
    assert.equal(f.get('collectionReference').required, true);
    assert.equal(f.get('collectionCashConfirmed').disabled, true);
    await f.submit(); assert.equal(f.requests.length, 0);
    f.get('collectionReference').value = 'TRANSFER-123'; await f.submit();
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.method, method);
    assert.equal(f.requests[0].body.reference, 'TRANSFER-123'); assert.equal(f.requests[0].body.cashReceivedConfirmed, false);
    assert.equal(f.requests[0].body.proofUrl, undefined);
  }
});

test('switching to cash excludes an old transfer reference and collects without evidence', async () => {
  const f = fixture(); await f.open(); f.method('gcash');
  f.get('collectionReference').value = 'OLD-TRANSFER';
  f.method('cash'); f.get('collectionCashConfirmed').checked = true;
  await f.submit(); assert.equal(f.requests[0].body.reference, '');
  assert.equal(f.requests[0].body.proofUrl, undefined);
});

test('reopening the dialog resets method, confirmation and notes', async () => {
  const f = fixture(); await f.open(); f.get('collectionSupportingDetails').open = true;
  f.get('paymentNotesInput').value = 'Old notes'; f.get('collectionCashConfirmed').checked = true;
  f.method('bank');
  await f.open();
  assert.equal(f.get('collectionMethod').value, 'cash'); assert.equal(f.get('collectionCashConfirmed').checked, false);
  assert.equal(f.get('collectionSupportingDetails').open, false);
  assert.equal(f.get('paymentNotesInput').value, ''); assert.equal(f.get('collectionReference').value, '');
});

test('failed cash collection preserves the details for retry and reenables the button', async () => {
  const f = fixture({ failPayment: true }); await f.open(); f.get('collectionCashConfirmed').checked = true;
  await f.submit(); assert.match(f.get('paymentErrorBox').textContent, /Refresh this booking/);
  assert.equal(f.get('confirmCollectBtn').disabled, false); assert.equal(f.get('collectionCashConfirmed').checked, true);
  f.options.failPayment = false; await f.submit(); assert.equal(f.requests.length, 2); assert.equal(f.messages[0].type, 'success');
});

test('mixed payment shows one itemized total and submits the entire aircon and repair balance once', async () => {
  const f = fixture({ booking: { serviceType: 'mixed', totalInitialCost: 1750, totalPrice: 2650, travelFare: 50,
    amountPaid: 250, approval: { status: 'approved' }, quotation: { totalCost: 900, laborCost: 500, parts: [{ name: 'Capacitor', cost: 400, quantity: 1 }] },
    services: [{ type: 'core', name: 'Aircon installation', status: 'completed', initialCost: 1200 },
      { type: 'repair', name: 'Aircon repair', status: 'repair_in_progress', initialCost: 500 }] } });
  await f.open();
  assert.equal(f.get('paymentMixedBreakdown').hidden, false);
  for (const label of ['Aircon services', 'Repair inspection', 'Approved repair', 'Travel fee']) assert.ok(f.get('paymentMixedBreakdown').innerHTML.includes(label));
  assert.equal(f.get('paymentTotalFee').textContent, '₱2,650'); assert.equal(f.get('paymentBalanceDue').textContent, '₱2,400');
  assert.equal(f.get('paymentPartsRow').style.display, 'none'); assert.equal(f.get('paymentQuotationBox').style.display, 'none');
  f.get('collectionCashConfirmed').checked = true; await f.submit();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.amount, 2400);
  assert.match(f.requests[0].url, /assignments\/assignment\/collect-payment$/);
});
