const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { normalizeHvacPrices } = require('../utils/hvacPricing');
const { summarizeOrderCosts } = require('../utils/enterpriseRevenue');
const { buildAirconProductSales } = require('../utils/airconSalesAnalytics');

test('bought and selling prices keep cents and reject invalid staff values', () => {
  assert.deepEqual(normalizeHvacPrices({ costPrice: '12000.55', sellingPrice: '16000.75' }), { costPrice: 12000.55, sellingPrice: 16000.75 });
  assert.equal(normalizeHvacPrices({ costPrice: '' }).costPrice, 0);
  assert.equal(normalizeHvacPrices({ quantity: 3 }).costPrice, undefined);
  for (const value of [-1, 'not a price', Infinity, NaN, true, {}]) {
    assert.throws(() => normalizeHvacPrices({ costPrice: value }), error => error.status === 400);
    assert.throws(() => normalizeHvacPrices({ sellingPrice: value }), error => error.status === 400);
  }
});

test('saved bought prices survive catalog price changes; older orders use current costs', () => {
  const orders = [{ items: [{ inventoryId: 'a', quantity: 2, costPrice: 12000.55 }, { inventoryId: 'b', quantity: 1 }] }];
  const summary = summarizeOrderCosts(orders, [{ _id:'a', costPrice:19000 }, { _id:'b', costPrice:8000 }]);
  assert.equal(summary.totalCost, 32001.1);
  assert.equal(summary.coveragePercent, 100);
  assert.equal(summary.legacyUnits, 1);
  const later = summarizeOrderCosts([{ items:[orders[0].items[0]] }], [{ _id:'a', costPrice:50000 }]);
  assert.equal(later.totalCost, 24001.1);
});

test('missing bought prices on new orders stay missing and lower cost coverage', () => {
  const summary = summarizeOrderCosts([{ items: [{ inventoryId:'a', costPrice:null, quantity:2 }] }], [{ _id:'a', costPrice:5000 }]);
  assert.equal(summary.totalCost, 0);
  assert.equal(summary.costedUnits, 0);
  assert.equal(summary.legacyUnits, 0);
  assert.equal(summary.coveragePercent, 0);
});

test('aircon profit uses completed sales, quantity and line discounts, separating HP and sales channels', () => {
  const item = { inventoryId:'a', modelLine:'Midea X', brand:'Midea', capacity:'1', quantity:2, totalPrice:40000, discountAmount:2000, costPrice:15000 };
  const orders = [
    { status:'completed', items:[item] },
    { status:'completed', salesChannel:'walk_in', items:[{ ...item, quantity:1, totalPrice:20000, discountAmount:0 }] },
    { status:'completed', items:[{ ...item, capacity:'2', costPrice:null }] },
    { status:'cancelled', items:[item] },
    { status:'pending_payment', items:[item] },
  ];
  const result = buildAirconProductSales(orders, [{ _id:'a', costPrice:18000 }]);
  const rows = Object.values(result.productMap);
  assert.equal(rows.length,3);
  const online = rows.find(row => row.channel === 'order' && row.capacity === '1HP');
  assert.equal(online.revenue,38000);
  assert.equal(online.cost,30000);
  assert.equal(online.profit,8000);
  assert.equal(online.costComplete,true);
  assert.equal(rows.find(row => row.capacity === '2HP').costComplete,false);
  assert.equal(rows.find(row => row.channel === 'walk_in_order').profit,5000);
});

test('order cost snapshots persist as staff data and are hidden from normal order serialization', async () => {
  const doc = new Order({ userId:new mongoose.Types.ObjectId(), fulfillmentType:'customer_pickup', items:[{ inventoryId:new mongoose.Types.ObjectId(), quantity:1, costPrice:12345.67 }] });
  assert.equal(doc.items[0].costPrice,12345.67);
  assert.equal(doc.toObject().items[0].costPrice,undefined);
  assert.equal(doc.toJSON().items[0].costPrice,undefined);
  const stored = doc.toObject({ transform:false });
  assert.equal(stored.items[0].costPrice,12345.67);
  assert.equal(Order.schema.path('items').schema.path('costPrice').options.select,false);
  const legacy = new Order({ items:[{ inventoryId:new mongoose.Types.ObjectId(), quantity:1 }] });
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.toObject({transform:false}).items[0],'costPrice'),false);
});
