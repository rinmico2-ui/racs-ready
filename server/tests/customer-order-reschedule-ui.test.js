'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { initOrderReschedule } = require('../public/js/customer-order-reschedule');
const tick = () => new Promise(resolve => setImmediate(resolve));
function element() {
  const listeners = new Map(), classes = new Set(['d-none']);
  return { value:'', dataset:{}, disabled:false, textContent:'', innerHTML:'',
    classList:{ add:value => classes.add(value), remove:value => classes.delete(value), contains:value => classes.has(value) },
    addEventListener(type,callback,options = {}) { const rows = listeners.get(type) || []; rows.push({ callback,once:options.once }); listeners.set(type,rows); },
    emit(type,event = {}) { const rows = [...(listeners.get(type) || [])]; listeners.set(type,rows.filter(row => !row.once)); return Promise.all(rows.map(row => row.callback(event))); },
    setAttribute() {}, focus() { this.focused = true; }, remove() { this.removed = true; },
  };
}
function fixture(post) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id,element()); return elements.get(id); };
  const button = element(); button.dataset = { id:'order-1',ref:'ORD-1',fulfillment:'delivery_installation',currentSchedule:'Jan 1, 2030' };
  const card = { querySelector:() => null, insertBefore(note) { this.note = note; } }; button.closest = () => card;
  const modalElement = get('orderRescheduleModal'), close = element(); modalElement.querySelectorAll = () => [close];
  const events = [];
  const doc = { getElementById:get,body:{ appendChild() {} },querySelectorAll:() => [button],createElement:element,dispatchEvent:event => events.push(event) };
  const modal = { hides:0,show() {},hide() { this.hides++; modalElement.emit('hidden.bs.modal'); } };
  let posts = 0;
  class Picker {
    constructor(_root,date,time,onChange) { this.date = date; this.time = time; this.onChange = onChange; }
    reset() { this.date.value = ''; this.time.value = ''; this.onChange(); }
    setDates() { return true; }
    async selectDate(key) { this.date.value = key; this.time.value = ''; this.onChange(); }
  }
  const win = { bootstrap:{ Modal:{ getOrCreateInstance:() => modal } },OrderReschedulePicker:Picker,AbortController,
    CustomEvent:class { constructor(type,options) { this.type = type; this.detail = options.detail; } },
    fetch:async (_url,options) => {
      if (options.method === 'POST') { posts++; return post(); }
      return { ok:true,status:200,json:async () => ({ availableDates:[{ date:'2030-01-02',availableSlots:1 }] }) };
    } };
  const controller = initOrderReschedule(doc,win);
  async function open() { await button.emit('click'); await tick(); get('rescheduleDate').value = '2030-01-02'; get('rescheduleTime').value = '09:00'; get('rescheduleReason').value = 'My availability changed'; await get('rescheduleReason').emit('input'); }
  return { get,button,card,modal,modalElement,events,controller,open,posts:() => posts };
}

test('a fast successful submission closes after the modal entrance transition and shows the pending request once', async () => {
  const f = fixture(async () => ({ ok:true,status:200,json:async () => ({ message:'Request submitted' }) }));
  await f.open();
  await f.get('submitReschedule').emit('click');
  assert.equal(f.modal.hides,0); assert.equal(f.get('submitReschedule').disabled,true);
  assert.equal(f.button.removed,true); assert.match(f.card.note.textContent,/under review/);
  assert.equal(f.events[0].type,'orders:reschedule-submitted');
  await f.modalElement.emit('shown.bs.modal');
  assert.equal(f.modal.hides,1); assert.equal(f.posts(),1);
});

test('submission blocks duplicate clicks and edits, then restores the form without losing the reason on errors', async () => {
  let resolveResponse;
  const f = fixture(() => new Promise(resolve => { resolveResponse = resolve; }));
  await f.open(); await f.modalElement.emit('shown.bs.modal');
  const first = f.get('submitReschedule').emit('click');
  await f.get('submitReschedule').emit('click');
  assert.equal(f.posts(),1); assert.equal(f.get('rescheduleReason').readOnly,true); assert.equal(f.get('rescheduleCalendar').inert,true);
  resolveResponse({ ok:false,status:409,json:async () => ({ error:'Choose another start time.',refreshSlots:true }) });
  await first;
  assert.equal(f.get('rescheduleReason').value,'My availability changed'); assert.equal(f.get('rescheduleReason').readOnly,false);
  assert.equal(f.get('rescheduleTime').value,''); assert.equal(f.get('submitReschedule').disabled,true);
  assert.equal(f.get('rescheduleError').textContent,'Choose another start time.'); assert.equal(f.get('rescheduleError').focused,true);
  assert.equal(f.modal.hides,0); assert.equal(f.events.length,0);
});
