const test = require('node:test');
const assert = require('node:assert/strict');

const { minuteValue, orderWindow } = require('../utils/orderAssignmentPlanner');

test('order assignment planner parses checkout time labels and 24-hour values', () => {
  assert.equal(minuteValue('09:00 AM - 11:00 AM'), 9 * 60);
  assert.equal(minuteValue('2:30 PM'), 14 * 60 + 30);
  assert.equal(minuteValue('16:00'), 16 * 60);
});

test('explicit checkout ranges remain the authoritative assignment window', () => {
  assert.deepEqual(orderWindow({
    fulfillmentType: 'delivery_installation',
    timeSlot: '09:00 AM - 12:00 PM',
    items: [{ quantity: 1 }],
  }), { start: 540, end: 720, duration: 180 });
});

test('installation planning scales duration by ordered unit quantity', () => {
  assert.deepEqual(orderWindow({
    fulfillmentType: 'delivery_installation',
    timeSlot: '13:00',
    items: [{ quantity: 3 }],
  }), { start: 780, end: 960, duration: 180 });
});

test('delivery-only planning reserves delivery time without installation work', () => {
  assert.deepEqual(orderWindow({
    fulfillmentType: 'delivery_only',
    timeSlot: '10:00',
    items: [{ quantity: 2 }],
  }), { start: 600, end: 690, duration: 90 });
});
