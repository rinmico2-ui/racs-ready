'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const sift = require('sift').default;
const { read, releaseDemand } = require('../utils/bookingEmergencyEquipment');
const id = n => n.toString(16).padStart(24, '0');
const B=id(1), OTHER=id(2), T=id(3), K=id(4), L=id(5), U=id(6);
const booking = { _id:B, bookingDate:'2026-10-19', staffingEmergencies:[{ reportedAt:new Date('2026-10-19T12:00Z'), team:[{ technicianId:T, name:'Previous primary' }] }] };
const query = rows => ({ select() { return this; }, lean:async()=>rows });
test('live custody combines reusable tools and unreturned materials without including unrelated shared-kit items', async () => {
  const kits=[{_id:K,technicianId:T,items:[
    {_id:id(7),name:'Shared pump',category:'equipment',bookingIds:[B],custodyAssignmentIds:[L]},
    {_id:id(8),name:'Cleaner',category:'consumable',issuedBookingIds:[B],quantityIssued:8,quantityUsed:2,quantityReturned:1,quantityDamaged:1,returnPendingQuantity:1},
    {_id:id(9),name:'Other booking tool',category:'equipment',bookingIds:[OTHER],custodyAssignmentIds:[U]},
    {_id:id(10),name:'New unissued cleaner',category:'consumable',bookingIds:[B],quantityIssued:0},
  ]}];
  const equipment=[
    {_id:L,bookingId:OTHER,dailyKitId:K,technicianId:T,equipmentName:'Shared pump',quantity:1,status:'checked_out'},
    {_id:U,bookingId:OTHER,dailyKitId:K,technicianId:T,equipmentName:'Other booking tool',quantity:1,status:'checked_out'},
    {_id:id(11),bookingId:B,technicianId:T,equipmentName:'Already returned',quantity:1,status:'returned'},
    {_id:id(12),bookingId:B,technicianId:T,equipmentName:'Unused reservation',quantity:1,status:'reserved'},
  ];
  const before=JSON.stringify({kits,equipment});
  const result=await read(booking,{Kit:{find:filter=>query(kits.filter(sift(filter)))},Equipment:{find:filter=>query(equipment.filter(sift(filter)))}});
  assert.deepEqual(result.items.map(row=>row.name),['Shared pump','Unused reservation','Cleaner']);
  assert.equal(result.items[2].quantity,4);assert.equal(result.items[2].returnPendingQuantity,1);
  assert.equal(result.items[2].state,'return_pending');assert.equal(result.items[0].holder,'Previous primary');
  assert.equal(result.items[1].state,'reserved');assert.equal(JSON.stringify({kits,equipment}),before,'Read must never alter stock or custody');
});
test('legacy consumable custody reports only the unused and unreturned balance', async () => {
  const result=await read(booking,{Kit:{find:()=>query([])},Equipment:{find:()=>query([
    {_id:L,technicianId:T,equipmentName:'Legacy cleaner',consumable:true,quantity:10,consumableUsed:3,consumableReturned:2,consumableDamaged:1,consumableMissing:1,status:'in_use'},
  ])}});
  assert.equal(result.items.length,1);assert.equal(result.items[0].quantity,3);
});
test('a booking without an emergency avoids kit and inventory reads', async () => {
  const unused={find:()=>assert.fail('No emergency inventory query expected')};
  assert.deepEqual(await read({_id:B},{Kit:unused,Equipment:unused}),{items:[],hasReport:false});
});
test('order custody includes issued order items and excludes another order in the same kit', async () => {
  const order = { ...booking, delivery: { preferredDate: booking.bookingDate } }, queries = [];
  const Kit = { find: filter => { queries.push(filter); return { select() { return this; }, lean: async () => [{ technicianId: T,
    items: [{ _id: id(70), category: 'consumable', name: 'Order materials', quantityIssued: 3, quantityReturned: 1,
      orderIds: [B], issuedOrderIds: [B] }, { _id: id(71), category: 'consumable', name: 'Another order', quantityIssued: 8,
      orderIds: [id(72)], issuedOrderIds: [id(72)] }] }] }; } };
  const Equipment = { find: filter => { queries.push(filter); return { select() { return this; }, lean: async () => [] }; } };
  const result = await read(order, { Kit, Equipment }, 'order');
  assert.deepEqual(result.items.map(row => row.name), ['Order materials']); assert.equal(result.items[0].quantity, 2);
  assert.equal(queries[1].$or[0].orderIds, B);
});
test('emergency follow-up releases only prior unissued reservations and refreshes every previous member once', async () => {
  const released=[],synced=[];
  const incident={...booking.staffingEmergencies[0],team:[{technicianId:T},{technicianId:U},{technicianId:T}]};
  await releaseDemand({booking,incident},id(22),{release:async args=>released.push(args),syncKit:async(...args)=>synced.push(args)});
  assert.equal(released.length,1);assert.deepEqual(released[0].filter.technicianId.$in,[T,U]);
  assert.equal(released[0].filter.bookingId,B);assert.equal(released[0].filter.createdAt.$lte,incident.reportedAt);
  assert.deepEqual(synced.map(row=>row[0]),[T,U]);assert.ok(synced.every(row=>row[2].automatic===true));
});
test('reservation release never restores or transfers physically checked-out equipment', async t => {
  const Equipment=require('../models/EquipmentAssignment'),Tool=require('../models/Tool');
  const at=new Date('2026-10-19T11:00Z');
  const rows=[{_id:L,bookingId:B,technicianId:T,equipmentId:id(30),quantity:1,status:'reserved',createdAt:at},
    {_id:U,bookingId:B,technicianId:T,equipmentId:id(31),quantity:1,status:'checked_out',createdAt:at}];
  const updates=[];
  t.mock.method(Equipment,'find',async filter=>rows.filter(sift(filter)));
  t.mock.method(Equipment,'findOneAndUpdate',async(filter,update)=>{const row=rows.find(sift(filter));if(!row)return null;Object.assign(row,update.$set);return row;});
  t.mock.method(Tool,'findByIdAndUpdate',async(...args)=>updates.push(args));
  await releaseDemand({booking,incident:booking.staffingEmergencies[0]},id(22),{syncKit:async()=>{}});
  assert.equal(rows[0].status,'released');assert.equal(rows[1].status,'checked_out');assert.equal(rows[1].technicianId,T);
  assert.equal(updates.length,1);assert.equal(updates[0][0],id(30));
  assert.ok(updates[0][1][0].$set.reservedQuantity,'Only reservation accounting changes; physical quantity is not restored');
});
test('one failed kit refresh still attempts the other members without retrying the emergency', async () => {
  const seen=[];
  await assert.rejects(releaseDemand({booking,incident:{team:[{technicianId:T},{technicianId:U}]}},id(22),{
    release:async()=>{},syncKit:async tech=>{seen.push(tech);if(tech===T)throw Error('Synthetic sync failure');},
  }),/Synthetic sync failure/);
  assert.deepEqual(seen,[T,U]);
});
test('duplicate emergency submissions do not release reservations or regenerate kits twice', async () => {
  const unexpected=()=>assert.fail('Duplicate cleanup');
  await releaseDemand({duplicate:true},id(22),{release:unexpected,syncKit:unexpected});
});
test('the custody endpoint permits staff, denies customers, validates references and disables caching', async t => {
  const express=require('express'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),mongoose=require('mongoose');
  const {requireRole}=require('../middleware/authenticate');
  const source=fs.readFileSync(path.join(__dirname,'../routes/appointmentManagement.js'),'utf8');
  const start=source.indexOf("router.get('/:id/emergency-equipment',"),end=source.indexOf('\n});',start);
  let lookups=0,record=booking;
  const app=express();app.use((req,_res,next)=>{req.user={_id:U,role:req.headers['x-test-role']};next();});
  vm.runInNewContext(source.slice(start,end+5),{router:app,requireRole,mongoose,
    BookingService:{findById:()=>{lookups++;return{select(){return this;},lean:async()=>record};}},
    require:()=>({read:async()=>({hasReport:true,items:[{name:'Pump',holder:'Previous primary'}]})}),
  });
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const get=(role,key=B)=>fetch(`http://127.0.0.1:${server.address().port}/${key}/emergency-equipment`,{headers:{'x-test-role':role}});
  assert.equal((await get('customer')).status,403);assert.equal(lookups,0);
  for(const role of ['admin','secretary']){const res=await get(role);assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'private, no-store');assert.equal((await res.json()).items[0].holder,'Previous primary');}
  assert.equal((await get('admin','invalid')).status,400);
  record=null;assert.equal((await get('admin')).status,404);
});
