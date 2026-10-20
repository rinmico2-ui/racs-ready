'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../public/js/appliance-services');
const source = fs.readFileSync(require.resolve('../public/js/services-multi.js'), 'utf8').replace(/\r\n/g, '\n');
const core = {id:'core-1', type:'core', serviceId:'cleaning', name:'Cleaning', brand:'Carrier', quantity:1, unitPrice:500, totalPrice:500};
const repair = {id:'repair-1', type:'repair', name:'Repair inspection', brand:'Midea', quantity:1, unitPrice:500, totalPrice:500};

function declaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const boundaries = ['\nfunction ', '\nasync function '].map(marker=>source.indexOf(marker, start+1)).filter(index=>index>=0);
  return source.slice(start, Math.min(...boundaries));
}
function ui(rows) {
  const state = {selectedServices:structuredClone(rows), editingServiceId:null, currentStep:5,
    customerLocation:{lat:15.4863,lng:120.9671,pinConfirmed:true}, selectedDate:'2035-01-02',
    selectedTimeSlot:{startTime:'08:00'}, paymentMethod:'cod', paymentChannel:'bank_transfer'};
  const elements = Object.fromEntries(['core-tab', 'repair-tab', 'core-services', 'repair-services', 'coreServiceSelection', 'repairServiceSelection'].map(id=>[id,{
    disabled:false,inert:false,classList:{contains:()=>false},
    description:{textContent:id==='core-tab'?'Cleaning, installation and maintenance':'Inspection, diagnosis and repairs'},
  }]));
  elements.cashNumber={value:'TEST-REFERENCE'};
  elements.cashProof={files:[{}]};
  const errors = [], saves = [];
  const context = {BookingState:state, window:{ApplianceServices:policy}, document:{getElementById:id=>elements[id]||null},
    normalizeBookingStep:value=>value, bookingDebug(){}, remainingBookingUnits:()=>40, MAX_BOOKING_UNITS:40,
    selectedUnitTotal:()=>policy.unitCount(state.selectedServices), bookingRequiresProjectSchedule:()=>false,
    paymentProofValidationMessage:()=>null,
    generateUniqueId:()=> 'new-service', isRepairBookingService:item=>item.type==='repair', bookingServiceIcon:()=> 'bi-tools',
    showError:message=>errors.push(message), updateSelectedServicesDisplay(){}, updatePricingDisplay(){},
    showAlert:message=>errors.push(message), showBookingToast(){}, DOM:{}, reconcileBookingScheduleAfterServiceChange(){},
    updateContinueButtonState(){}, updateRepairIssueDisplay(){}, saveBookingProgress:()=>saves.push(true)};
  vm.runInNewContext(['commitCoreAppliance','commitRepairAppliance','addServiceToBooking','getBookingStepIssue','getRestorableBookingStep','validateBookingData','updateSelectedServicesDisplay','removeService','addCurrentRepairItem'].map(declaration).join('\n'), context);
  return {state,elements,errors,saves,context};
}

test('customer selections allow Core and Repair together while rejecting malformed service types', () => {
  for (const rows of [[],[core],[repair],[core,repair],[repair,core],[{},repair]]) {
    assert.doesNotThrow(()=>policy.assertServiceTypes(rows));
  }
  for (const rows of [null,{},[null],[[]],[{type:'mixed'}],[core,{type:'unknown'}]]) {
    assert.throws(()=>policy.assertServiceTypes(rows), {status:400,code:'SERVICE_SELECTION_INVALID'});
  }
});

test('both appliance builders can add the other category without changing existing details', () => {
  const withCore = ui([core]);
  withCore.context.commitRepairAppliance(repair);
  assert.deepEqual(withCore.state.selectedServices, [core,repair]);
  assert.equal(withCore.saves.length,1);
  const withRepair = ui([repair]);
  withRepair.context.commitCoreAppliance([core]);
  assert.deepEqual(withRepair.state.selectedServices, [repair,core]);
  assert.equal(withRepair.saves.length,1);
});

test('adding, editing and removing services keeps both service forms available', () => {
  const f = ui([core]);
  f.context.commitRepairAppliance(repair);
  f.context.commitRepairAppliance({...repair,brand:'Daikin'},repair.id);
  assert.equal(f.state.selectedServices.length,2);
  assert.deepEqual(f.state.selectedServices[0],core);
  assert.equal(f.state.selectedServices[1].brand,'Daikin');
  for (const category of ['core','repair']) {
    assert.equal(f.elements[`${category}-tab`].disabled,false);
    assert.equal(f.elements[`${category}ServiceSelection`].disabled,false);
    assert.equal(f.elements[`${category}-services`].inert,false);
  }
  assert.equal(f.elements['repair-tab'].description.textContent,'Inspection, diagnosis and repairs');
  f.context.removeService(core.id);
  assert.equal(f.state.selectedServices.length,1);
  assert.equal(f.state.selectedServices[0].brand,'Daikin');
  assert.equal(f.elements['core-tab'].disabled,false);
});

test('the legacy service picker can append Repair to a Core booking', () => {
  const f = ui([core]);
  f.context.addServiceToBooking({_id:'repair-catalog',name:'Repair',type:'repair'},1);
  assert.equal(f.errors.length,0);
  assert.equal(f.state.selectedServices.length,2);
  assert.deepEqual(f.state.selectedServices[0],core);
  assert.equal(f.state.selectedServices[1].type,'repair');
});

test('repair identification remains available when Core services are already selected', () => {
  const f = ui([core]); let opened=false;
  f.context.repairNeedsIdentification=()=>true;
  f.context.reviewRepairIdentification=()=>{opened=true;};
  f.context.addCurrentRepairItem();
  assert.equal(opened,true);
  assert.equal(f.errors.length,0);
  assert.deepEqual(f.state.selectedServices,[core]);
});

test('combined drafts keep their current step and pass checkout validation', () => {
  const f = ui([core,repair]), before=structuredClone(f.state.selectedServices);
  assert.equal(f.context.getRestorableBookingStep(),5);
  assert.equal(f.context.getBookingStepIssue(2),null);
  assert.equal(f.context.validateBookingData().valid,true);
  assert.deepEqual(f.state.selectedServices,before);
});

test('combined bookings still enforce the appliance limit and standalone relocation rule', () => {
  const f=ui([{...core,quantity:40}]);
  assert.throws(()=>f.context.commitRepairAppliance(repair),/40 appliances/);
  assert.equal(f.state.selectedServices.length,1);
  const relocation={...core,slug:'aircon-relocation'};
  const moving=ui([relocation]);
  assert.throws(()=>moving.context.commitRepairAppliance(repair),/Relocation must be booked on its own/);
  assert.deepEqual(moving.state.selectedServices,[relocation]);
});

test('the older customer booking endpoint accepts combined arrays and JSON before checking required fields', async () => {
  const legacy=fs.readFileSync(require.resolve('../routes/bookingRoutes'),'utf8').replace(/\r\n/g,'\n');
  const begin=legacy.indexOf("router.post('/create',"), start=legacy.indexOf('async (req, res) => {',begin), end=legacy.indexOf('\n});',start);
  const handler=vm.runInNewContext('('+legacy.slice(start,end+2)+')',{
    console:{log(){},warn(){},error(){}},
    require:name=>{assert.equal(name,'../public/js/appliance-services');return policy;},
  });
  for (const services of [[core,repair],JSON.stringify([repair,core])]) {
    const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;}};
    await handler({body:{services}},response);
    assert.equal(response.statusCode,400);
    assert.equal(response.body.error,'Technician ID is required');
  }
});
