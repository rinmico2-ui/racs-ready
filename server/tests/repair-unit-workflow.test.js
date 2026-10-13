'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const Booking = require('../models/BookingService');
const flow = require('../utils/repairUnitWorkflow');
const { projectUnits } = require('../utils/projectWorkOrderPlanning');
const { normalizeProjectWorkSubmission } = require('../utils/projectWorkSubmission');
const actor = new mongoose.Types.ObjectId(), technician = new mongoose.Types.ObjectId();
const fees = { minor: 300, standard: 500, complex: 800, major: 1500 };
function project(quantity = 2) {
  const booking = new Booking({ customerId: actor, serviceType:'repair', quantity, services:[{ name:'Aircon repair', unitType:'Split Aircon', type:'repair', quantity, brand:'Carrier', model:'Nexus', problemDescription:'Different cooling problems', units:flow.customerUnits({ quantity, problemDescription:'Different cooling problems', units:Array.from({length:quantity}, (_,i) => ({label:`Room ${i+1}`, problemDescription:i % 2 ? 'Water leaking inside' : 'Aircon does not cool'})) }) }] });
  return new Project({ bookingId:booking._id, customerId:actor, quantity, totalUnits:quantity, estimatedTotalHours:quantity * 1.5, requestedUnitCount:quantity, repairUnitTracking:true, projectPhase:'assessment', unitGroups:flow.buildUnitGroups(booking) });
}
const input = overrides => ({findings:'Cooling test confirms faulty capacitor.',diagnosis:'Faulty capacitor',parts:[{name:'Capacitor',quantity:1,cost:120}],laborCategory:'minor',totalCost:99999,...overrides});
function inspectAll(p) { for (const row of flow.ensureUnits(p)) flow.inspect(p,row.key,input({laborCategory:row.unit.unitIndex % 2 ? 'minor' : 'complex'}),{technicianId:technician,laborFees:fees}); }
function reviewAll(p) { inspectAll(p); flow.submitInspection(p); flow.review(p,'approve',actor); }

test('40 appliances retain individual problems, labels, model names and stable work keys', async () => {
  const p=project(40); await p.validate();
  assert.equal(flow.rows(p).length,40); assert.equal(p.unitGroups[0].model,'Nexus');
  assert.equal(flow.rows(p)[0].unit.problemDescription,'Aircon does not cool');
  assert.equal(flow.rows(p)[1].unit.problemDescription,'Water leaking inside');
  assert.equal(projectUnits(p)[39].unitKey,'G1-U040'); assert.equal(projectUnits(p)[39].label,'Room 40');
});
test('customer details cannot forge diagnoses, approval or completion', () => {
  const units=flow.customerUnits({quantity:1,problemDescription:'Aircon not cooling',units:[{label:'Bedroom',problemDescription:'Aircon not cooling',status:'completed',repairReview:{state:'approved'},quotation:{totalCost:1}}]});
  assert.equal(units[0].status,'pending'); assert.equal(units[0].repairReview.state,'pending'); assert.equal(units[0].quotation,undefined);
  assert.throws(() => flow.customerUnits({quantity:2,units:[{}]}),/matching the quantity/);
});
test('mixed projects are recognized as needing repair assessment', () => {
  assert.equal(flow.hasRepair({serviceType:'mixed'}),true);
  assert.equal(flow.hasRepair({unitGroups:[{serviceType:'core'},{serviceType:'repair'}]}),true);
});
test('each appliance receives its own findings and computed quote; submitted totals are ignored', () => {
  const p=project();inspectAll(p);
  assert.equal(flow.rows(p)[0].unit.quotation.totalCost,420);
  assert.equal(flow.rows(p)[1].unit.quotation.totalCost,920);
  assert.equal(flow.rows(p)[0].unit.diagnosis.summary,'Faulty capacitor');
  assert.equal(flow.summary(p).totalAmount,1340);
});
test('catalog selling prices and configured labor fees override client prices', () => {
  const p=project(1),partId=new mongoose.Types.ObjectId();
  flow.inspect(p,'G1-U001',input({parts:[{toolId:partId,quantity:2,cost:1}],laborCost:1}),{technicianId:technician,laborFees:fees,catalog:[{_id:partId,itemName:'Capacitor',sellingPrice:250}]});
  assert.equal(flow.rows(p)[0].unit.quotation.totalCost,800);
  assert.throws(() => flow.inspect(p,'G1-U001',input({parts:[{toolId:new mongoose.Types.ObjectId(),quantity:1}]}),{laborFees:fees,catalog:[]}),/unavailable/);
});
test('invalid findings, parts, prices and quantity cannot produce a quote', () => {
  for (const invalid of [{findings:''},{diagnosis:''},{parts:[{name:'Part',quantity:1.5,cost:10}]},{parts:[{name:'Part',quantity:1,cost:-10}]},{laborCategory:'fake'}]) assert.throws(() => flow.inspect(project(),'G1-U001',input(invalid),{laborFees:fees}),/findings|quantities|price|category/);
});
test('staff review requires every appliance to be inspected and quoted', () => {
  const p=project();flow.inspect(p,'G1-U001',input(),{laborFees:fees});
  assert.throws(() => flow.submitInspection(p),/every appliance/);
  assert.throws(() => flow.review(p,'approve',actor),/All appliances/);
});
test('staff approval waits for the customer and cannot start execution', () => {
  const p=project();reviewAll(p);
  assert.equal(p.projectPhase,'quotation_review');assert.equal(p.quotationReview.status,'awaiting_customer');
  assert.equal(flow.rows(p)[0].unit.repairReview.state,'customer_review');
});
test('customer can approve one appliance and decline another without being charged for the declined repair', () => {
  const p=project();reviewAll(p);
  assert.equal(flow.decide(p,[{key:'G1-U001',approved:true,revision:1}],actor),false);
  assert.equal(p.projectPhase,'quotation_review');
  assert.equal(flow.decide(p,[{key:'G1-U002',approved:false,revision:1}],actor),true);
  assert.equal(p.projectPhase,'execution');assert.equal(p.quotationReview.totalAmount,420);
  assert.deepEqual(projectUnits(p).map(unit=>unit.unitKey),['G1-U001']);
});
test('stale or repeated decisions and duplicate selections are rejected before mutation', () => {
  const p=project();reviewAll(p);
  assert.throws(() => flow.decide(p,[{key:'G1-U001',approved:true,revision:0}],actor),/changed/);
  assert.throws(() => flow.decide(p,[{key:'G1-U001',approved:true,revision:1},{key:'G1-U001',approved:false,revision:1}],actor),/distinct/);
  assert.equal(flow.rows(p)[0].unit.repairReview.state,'customer_review');
});
test('staff rejection requires a reason and sends quotes back for correction', () => {
  const p=project();inspectAll(p);flow.submitInspection(p);
  assert.throws(() => flow.review(p,'reject',actor,''),/Explain/);
  flow.review(p,'reject',actor,'Check the test results');assert.equal(p.projectPhase,'assessment');
  flow.inspect(p,'G1-U001',input(),{laborFees:fees});assert.equal(flow.rows(p)[0].unit.repairReview.revision,2);
});
test('mixed project quotes include booked core work once alongside individual repairs', () => {
  const p=project(1);p.unitGroups.push({groupIndex:1,serviceType:'core',quantity:2,unitPrice:800,serviceName:'Cleaning'});reviewAll(p);
  assert.equal(p.quotationReview.totalAmount,2020);
  flow.decide(p,[{key:'G1-U001',approved:false,revision:1}],actor);assert.equal(p.quotationReview.totalAmount,1600);
});
test('repair completion selects exact approved units and rejects quantity-only, held, declined or duplicate units', () => {
  const p=project();reviewAll(p);flow.decide(p,[{key:'G1-U001',approved:true,revision:1},{key:'G1-U002',approved:false,revision:1}],actor);
  const order={serviceType:'repair',units:[{unitKey:'G1-U001',serviceType:'repair',status:'pending'},{unitKey:'G1-U002',serviceType:'repair',status:'pending'}]};
  assert.throws(() => flow.selectCompletedUnits(p,order,{completedUnits:1}),/exact/);
  assert.throws(() => flow.selectCompletedUnits(p,order,{completedUnits:1,unitKeys:['G1-U002']}),/approved/);
  assert.equal(flow.selectCompletedUnits(p,order,{completedUnits:1,unitKeys:['G1-U001']})[0].unitKey,'G1-U001');
  order.units[0].status='on_hold';assert.throws(() => flow.selectCompletedUnits(p,order,{completedUnits:1,unitKeys:['G1-U001']}),/unavailable/);
});
test('completion request preserves exact keys and rejects duplicate keys or wrong counts', () => {
  const body={clientSubmissionId:'test-submission',consumables:[],consumablesDeclaredNone:true,workOrders:[{workOrderId:'order',completedUnits:1,unitKeys:['G1-U002']}]};
  assert.deepEqual(normalizeProjectWorkSubmission(body).workOrders[0].unitKeys,['G1-U002']);
  assert.throws(() => normalizeProjectWorkSubmission({...body,workOrders:[{workOrderId:'order',completedUnits:2,unitKeys:['G1-U002','G1-U002']}]}),/distinct/);
});
test('aftercare is created for repaired appliances and excludes declined appliances', () => {
  const { bookingAssetSeeds } = require('../utils/maintenanceLifecycle');
  const booking = { _id:new mongoose.Types.ObjectId(), customerId:actor, repairUnitTracking:true, services:[{type:'repair',quantity:2,name:'Aircon repair',units:[{unitIndex:1,label:'Bedroom',repairReview:{state:'completed'}},{unitIndex:2,label:'Office',repairReview:{state:'declined'}}]}] };
  const assets=bookingAssetSeeds(booking);assert.equal(assets.length,1);assert.equal(assets[0].equipment.unitLabel,'Bedroom');
});
