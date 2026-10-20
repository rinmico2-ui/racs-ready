'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../public/js/appliance-field-guide');

function fixture() {
  let available = true, allowFocus = true;
  const fields = ['unit1-brand','unit1-type','unit1-hp','unit2-brand','unit2-type','unit2-hp'].map(key => ({ key, complete: false }));
  const tasks = [], focus = [], paints = [];
  const guide = createController({ fields: () => available ? fields : [], schedule: callback => tasks.push(callback),
    paint: state => paints.push(state), focus: (field, validate) => focus.push({ key: field?.key || 'choose-services', validate }), canMove: () => allowFocus,
  });
  guide.refresh();
  const flush = () => { while (tasks.length) tasks.shift()(); };
  const enter = key => guide.entered(key);
  const finish = (key, options = { automatic: true }) => { enter(key); fields.find(field => field.key === key).complete = true; guide.commit(key, options); flush(); };
  return { guide, fields, focus, paints, flush, enter, finish, disable: () => { available = false; }, preventFocus: () => { allowFocus = false; } };
}

test('confirmed dropdown choices lead from brand to type, HP, and the next aircon', () => {
  const f = fixture();
  for (const key of ['unit1-brand','unit1-type','unit1-hp']) f.finish(key);
  assert.deepEqual(f.focus.map(move => move.key), ['unit1-type','unit1-hp','unit2-brand']);
  assert.equal(f.paints.at(-1).completed, 3); assert.equal(f.paints.at(-1).total, 6);
});

test('copied details are skipped while the first genuinely missing unit detail stays highlighted', () => {
  const f = fixture(); f.fields[1].complete = true; f.fields[3].complete = true;
  f.finish('unit1-brand'); assert.equal(f.focus.at(-1).key, 'unit1-hp');
  f.finish('unit1-hp'); assert.equal(f.focus.at(-1).key, 'unit2-type');
});

test('typing never moves focus; Enter commits a completed text field', () => {
  const f = fixture(); f.enter('unit1-brand');
  f.fields[0].complete = true; f.guide.refresh(); assert.equal(f.focus.length, 0);
  f.guide.commit('unit1-brand', { automatic: false }); f.flush(); assert.equal(f.focus.length, 0);
  f.guide.commit('unit1-brand', { explicit: true }); f.flush(); assert.equal(f.focus.at(-1).key, 'unit1-type');
});

test('an invalid or missing value remains on its own field when Enter is pressed', () => {
  const f = fixture(); f.enter('unit1-hp'); f.guide.commit('unit1-hp', { explicit: true }); f.flush();
  assert.deepEqual(f.focus, [{ key: 'unit1-hp', validate: true }]);
  assert.equal(f.paints.at(-1).errorKey, 'unit1-hp'); assert.equal(f.paints.at(-1).target.key, 'unit1-hp');
});

test('arrow-key exploration of dropdown choices waits for an explicit commit', () => {
  const f = fixture(); f.finish('unit1-brand', { automatic: true, keyboard: true });
  assert.equal(f.focus.length, 0);
  f.guide.commit('unit1-brand', { explicit: true }); f.flush(); assert.equal(f.focus.at(-1).key, 'unit1-type');
});

test('correcting an already completed field keeps focus there', () => {
  const f = fixture(); f.fields[0].complete = true; f.guide.refresh();
  f.finish('unit1-brand'); assert.equal(f.focus.length, 0);
  assert.equal(f.paints.at(-1).target.key, 'unit1-type');
});

test('clicking another control cancels a pending handoff', () => {
  const f = fixture(); f.enter('unit1-brand'); f.fields[0].complete = true; f.guide.commit('unit1-brand', { automatic: true });
  f.guide.interrupt(); f.flush(); assert.equal(f.focus.length, 0);
});

test('Back, help, reset, or a hidden panel cannot receive a delayed field jump', () => {
  const f = fixture(); f.enter('unit1-brand'); f.fields[0].complete = true; f.guide.commit('unit1-brand', { automatic: true });
  f.disable(); f.flush(); assert.equal(f.focus.length, 0); assert.equal(f.paints.at(-1).fields.length, 0);
  const g = fixture(); g.preventFocus(); g.finish('unit1-brand'); assert.equal(g.focus.length, 0);
});

test('draft hydration and programmatic field updates do not move the customer', () => {
  const f = fixture(); f.finish('unit1-brand', { automatic: true, trusted: false });
  assert.equal(f.focus.length, 0); assert.equal(f.paints.at(-1).target.key, 'unit1-type');
});

test('optional empty fields are skipped and the last detail focuses Choose services without opening it', () => {
  const f = fixture(); f.fields.forEach(field => { field.complete = true; });
  f.fields.push({ key: 'optional-model', complete: true, count: false });
  f.guide.refresh(); f.guide.commit('unit2-hp', { explicit: true }); f.flush();
  assert.deepEqual(f.focus, [{ key: 'choose-services', validate: false }]);
  assert.equal(f.paints.at(-1).total, 6); assert.equal(f.paints.at(-1).completed, 6); assert.equal(f.paints.at(-1).target, null);
});

test('Enter supersedes a pending keyboard change with one handoff', () => {
  const f = fixture(); f.enter('unit1-brand'); f.fields[0].complete = true;
  f.guide.commit('unit1-brand', { automatic: true, keyboard: true }); f.guide.interrupt();
  f.guide.commit('unit1-brand', { explicit: true }); f.flush();
  assert.equal(f.focus.length, 1); assert.equal(f.focus[0].key, 'unit1-type');
});
