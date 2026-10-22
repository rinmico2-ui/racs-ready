'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/js/technician-order-payment.js'), 'utf8');
function fixture(options = {}) {
  const elements = new Map(), requests = [], errors = [], events = [], changes = [];
  let bill = { total: 6000, amountPaid: 1000, balanceDue: 5000, paymentStatus: 'partial', customerName: 'Test <Customer>', orderReference: 'TEST-ORDER' };
  let drive, failPost = options.failPost, reads = 0;
  const element = name => {
    assert.doesNotMatch(name, /Proof/, 'Collection no longer reads upload fields');
    const id = 'op' + name;
    if (!elements.has(id)) elements.set(id, { value: name === 'Method' ? 'cash' : '', files: [], checked: false,
      disabled: false, required: false, hidden: false, textContent: '',
      addEventListener(event, callback) { this[event] = callback; }, focus() { events.push('focus:' + name); } });
    return elements.get(id);
  };
  const window = { TechnicianWorkUpdates: { beginMutation() { events.push('begin'); return async needed => { events.push(needed === false ? 'no refresh' : 'refreshed'); return options.refreshFailed ? false : true; }; } } };
  const context = { window, console, Intl, navigator: {}, document: { getElementById: id => element(id.slice(2)) },
    FileReader: class { readAsDataURL(file) { this.result = 'data:' + file.type + ';base64,RECEIPT'; this.onload(); } },
    fetch: async (url, config = {}) => {
      if (url.endsWith('/collection-summary')) {
        reads++; if (options.readFails) return { ok: false, json: async () => ({ error: 'Balance unavailable' }) };
        return { ok: true, json: async () => ({ ...bill }) };
      }
      const body = JSON.parse(config.body); requests.push({ url, body }); events.push('posted');
      if (failPost) { failPost = false; return { ok: false, json: async () => ({ error: 'Try again; payment was not saved.' }) }; }
      bill.balanceDue = 0; bill.paymentStatus = 'waiting_for_remittance';
      return { ok: true, json: async () => ({ paymentId: 'payment-1', balanceAmount: 0, paymentStatus: 'waiting_for_remittance' }) };
    },
    Swal: { showValidationMessage: message => errors.push(message), async fire(config) {
      if (!config.preConfirm) { events.push(config.title); return { isConfirmed: true }; }
      assert.doesNotMatch(config.html, /type="file"|Payment screenshot|Receipt photo|Customer Signature|Customer Confirmation Photo/);
      assert.match(config.html, /Test &lt;Customer&gt;/);
      config.didOpen(); return drive(config);
    } } };
  vm.runInNewContext(source, context);
  const onCollected = data => { changes.push(data); events.push('balance updated'); };
  return { element, requests, errors, events, changes, window, get reads() { return reads; },
    setBill(values) { Object.assign(bill, values); },
    method(value) { element('Method').value = value; element('Method').change(); },
    async run(action) { drive = action; return window.TechnicianOrderPayment.collect('order-1', onCollected); },
    collected: onCollected };
}
test('cash collection is a current full balance and one acknowledgment, without mandatory customer evidence', async () => {
  const f = fixture();
  assert.equal(await f.run(async config => {
    assert.equal(f.element('Amount').value, '5000'); assert.equal(f.element('PaidRow').hidden, false);
    assert.match(f.element('CashLabel').textContent, /5,000\.00/);
    assert.equal(f.element('TransferWrap').hidden, true); assert.equal(f.element('Ref').disabled, true);
    assert.equal(await config.preConfirm(), false); assert.equal(f.requests.length, 0);
    f.element('CashConfirmed').checked = true;
    return { isConfirmed: true, value: await config.preConfirm() };
  }), true);
  const body = f.requests[0].body;
  assert.equal(body.amount, 5000); assert.equal(body.cashReceivedConfirmed, true); assert.equal(body.proofUrl, undefined);
  assert.equal(body.customerSignature, undefined); assert.equal(body.customerPhotoUrl, undefined);
  assert.deepEqual(f.events.slice(-5), ['begin', 'posted', 'balance updated', 'refreshed', 'Payment Collected']);
});

for (const method of ['gcash', 'bank']) {
  test(method + ' requires a transfer reference and submits without photos or cash acknowledgment', async () => {
    const f = fixture(); await f.run(async config => {
      f.method(method);
      assert.equal(f.element('CashWrap').hidden, true); assert.equal(f.element('CashConfirmed').disabled, true);
      assert.equal(f.element('TransferWrap').hidden, false); assert.equal(f.element('Ref').required, true);
      assert.equal(await config.preConfirm(), false);
      f.element('Ref').value = ' REF-123 ';
      return { isConfirmed: true, value: await config.preConfirm() };
    });
    assert.equal(f.requests.length, 1); const body = f.requests[0].body;
    assert.equal(body.method, method); assert.equal(body.reference, 'REF-123'); assert.equal(body.cashReceivedConfirmed, false);
    assert.equal(body.proofUrl, undefined); assert.equal(body.customerSignature, undefined);
  });
}

test('switching back to cash resets acknowledgment and excludes old transfer evidence', async () => {
  const f = fixture(); await f.run(async config => {
    f.element('CashConfirmed').checked = true;
    f.method('gcash'); f.element('Ref').value = 'OLD-TRANSFER';
    f.method('cash');
    assert.equal(f.element('CashConfirmed').checked, false);
    assert.equal(await config.preConfirm(), false);
    f.element('CashConfirmed').checked = true;
    return { isConfirmed: true, value: await config.preConfirm() };
  });
  assert.equal(f.requests[0].body.reference, ''); assert.equal(f.requests[0].body.proofUrl, undefined);
});

test('optional notes are saved without evidence', async () => {
  const f = fixture(); await f.run(async config => {
    f.element('Notes').value = ' Customer paid cash. ';
    f.element('CashConfirmed').checked = true;
    return { isConfirmed: true, value: await config.preConfirm() };
  });
  assert.equal(f.requests[0].body.proofUrl, undefined); assert.equal(f.requests[0].body.notes, 'Customer paid cash.');
});

test('changed balances require another review and reset the cash confirmation before posting', async () => {
  const f = fixture(); await f.run(async config => {
    f.element('CashConfirmed').checked = true; f.setBill({ amountPaid: 2000, balanceDue: 4000 });
    assert.equal(await config.preConfirm(), false); assert.equal(f.requests.length, 0);
    assert.equal(f.element('Amount').value, '4000'); assert.equal(f.element('CashConfirmed').checked, false);
    assert.match(f.errors.at(-1), /balance changed/);
    f.element('CashConfirmed').checked = true;
    return { isConfirmed: true, value: await config.preConfirm() };
  });
  assert.equal(f.requests[0].body.amount, 4000);
});

test('another device can settle payment while the dialog is open without collecting twice', async () => {
  const f = fixture(); await f.run(async config => {
    f.setBill({ balanceDue: 0, paymentStatus: 'waiting_for_remittance' }); f.element('CashConfirmed').checked = true;
    return { isConfirmed: true, value: await config.preConfirm() };
  });
  assert.equal(f.requests.length, 0); assert.equal(f.changes[0].balanceAmount, 0);
  assert.equal(f.events.at(-1), 'Payment Already Recorded');
});

test('a failed collection keeps the dialog draft for retry and refreshes only the successful save', async () => {
  const f = fixture({ failPost: true }); await f.run(async config => {
    f.element('CashConfirmed').checked = true; f.element('Notes').value = 'Keep this note';
    assert.equal(await config.preConfirm(), false);
    assert.match(f.errors.at(-1), /not saved/); assert.equal(f.element('Notes').value, 'Keep this note');
    assert.equal(f.element('Method').disabled, false);
    return { isConfirmed: true, value: await config.preConfirm() };
  });
  assert.equal(f.requests.length, 2); assert.equal(f.changes.length, 1);
  assert.equal(f.events.filter(event => event === 'refreshed').length, 1);
});

test('canceling the collection never records money or starts a status mutation', async () => {
  const f = fixture(); assert.equal(await f.run(async () => ({ isConfirmed: false })), false);
  assert.equal(f.requests.length, 0); assert.equal(f.changes.length, 0); assert.deepEqual(f.events, []);
});

test('a saved collection remains successful if refreshing the order details fails', async () => {
  const f = fixture({ refreshFailed: true });
  assert.equal(await f.run(async config => {
    f.element('CashConfirmed').checked = true;
    const value = await config.preConfirm();
    assert.equal(value.refreshFailed, true);
    return { isConfirmed: true, value };
  }), true);
  assert.equal(f.requests.length, 1); assert.equal(f.changes[0].balanceAmount, 0);
  assert.deepEqual(f.errors, []); assert.equal(f.events.at(-1), 'Payment Collected');
});

test('an order already settled never opens a second collection dialog', async () => {
  const f = fixture(); f.setBill({ balanceDue: 0, paymentStatus: 'paid' });
  assert.equal(await f.run(() => assert.fail('Must not open payment dialog')), true);
  assert.equal(f.requests.length, 0); assert.equal(f.changes[0].paymentStatus, 'paid');
});

test('a balance read failure prevents collection and repeated clicks share one pending dialog', async () => {
  const failed = fixture({ readFails: true }); await assert.rejects(failed.run(() => {}), /Balance unavailable/);
  assert.equal(failed.requests.length, 0);
  const f = fixture(); let release;
  const result = f.run(async () => new Promise(resolve => { release = resolve; }));
  const second = f.window.TechnicianOrderPayment.collect('order-1', f.collected);
  await new Promise(resolve => setImmediate(resolve)); release({ isConfirmed: false });
  assert.equal(await result, false); assert.equal(await second, false); assert.equal(f.reads, 1);
});
