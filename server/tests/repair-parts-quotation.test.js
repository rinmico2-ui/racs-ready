'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), sift = require('sift').default;
const Tool = require('../models/Tool');

test('repair quotations admit active replacement parts including zero stock, excluding tools, consumables and retired stock', () => {
  const items = [
    {itemName:'Capacitor',type:'part',inventoryClass:'merchandise',quantity:10,active:true},
    {itemName:'Motor to source',type:'part',quantity:0,status:'out_of_stock'},
    {itemName:'Legacy replacement',itemType:'part',quantity:0},
    {itemName:'Ladder',type:'equipment',inventoryClass:'merchandise'},
    {itemName:'Tape',type:'consumable',inventoryClass:'merchandise'},
    {itemName:'Multimeter',type:'tool'},
    {itemName:'Operational part',type:'part',inventoryClass:'operational_asset'},
    {itemName:'Inactive',type:'part',active:false},
    {itemName:'Discontinued',type:'part',status:'discontinued'},
  ];
  assert.deepEqual(items.filter(sift(Tool.repairPartFilter())).map(item=>item.itemName), ['Capacitor','Motor to source','Legacy replacement']);
});

function ui(parts) {
  const context = {window:{},document:{},Intl};
  const source=fs.readFileSync(require.resolve('../public/js/repair-units.js'),'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.partTest={init(parts){state={parts};},partRow,companyStock,quotationValid};})();'),context);
  context.window.partTest.init(parts);
  return context.window.partTest;
}

test('catalog quotation rows use the company selling price and saved identity, with no inventory dropdown per row', () => {
  const api=ui([{_id:'part-id',itemName:'Run capacitor',sellingPrice:500,quantity:8,reservedQuantity:3}]);
  const html=api.partRow({toolId:'part-id',name:'Forged item',cost:1,quantity:2});
  assert.match(html,/class="ru-part-id" value="part-id"/);
  assert.match(html,/value="Run capacitor" readonly/);
  assert.match(html,/value="500" readonly/);
  assert.doesNotMatch(html,/<select|Forged item/);
  assert.equal(api.companyStock({quantity:8,reservedQuantity:3}),5);
  assert.equal(api.companyStock({quantity:1,reservedQuantity:4}),0);
  assert.equal(api.companyStock({}),null);
});

test('supplier parts remain explicit and require the technician to supply a confirmed price', () => {
  const html=ui([]).partRow({name:'<supplier motor>',cost:null,quantity:1});
  assert.match(html,/Supplier part \/ specification/);
  assert.match(html,/value="&lt;supplier motor&gt;"/);
  assert.match(html,/class="ru-part-cost"[^>]+required[^>]+value=""/);
  assert.doesNotMatch(html,/readonly|<supplier motor>/);
});

test('a saved catalog identity is not silently converted into a supplier part after catalog removal', () => {
  const html=ui([]).partRow({toolId:'removed-id',name:'Removed part',cost:500});
  assert.match(html,/class="ru-part-id" value="removed-id"/);
});
