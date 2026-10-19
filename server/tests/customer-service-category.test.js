'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../public/js/appliance-services');
const source = fs.readFileSync(require.resolve('../public/js/services-multi.js'), 'utf8').replace(/\r\n/g, '\n');
const core = {id:'core-1', type:'core', serviceId:'cleaning', name:'Cleaning', quantity:1, unitPrice:500, totalPrice:500};
const repair = {id:'repair-1', type:'repair', name:'Repair inspection', quantity:1, unitPrice:500, totalPrice:500};

function declaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const boundaries = ['\nfunction ', '\nasync function '].map(marker=>source.indexOf(marker, start+1)).filter(index=>index>=0);
  return source.slice(start, Math.min(...boundaries));
}
function ui(rows) {
  const state = {selectedServices:structuredClone(rows), editingServiceId:null, currentStep:5};
  const elements = Object.fromEntries(['core-tab', 'repair-tab', 'core-services', 'repair-services', 'coreServiceSelection', 'repairServiceSelection', 'serviceTypePolicy'].map(id=>[id,{
    disabled:false,dataset:{},attributes:{},events:{},classList:{contains:()=>false},
    description:{textContent:id==='core-tab'?'Cleaning, installation and maintenance':'Inspection, diagnosis and repairs'},
    querySelector(selector){return selector==='.service-type-copy small'?this.description:null;},
    setAttribute(name,value){this.attributes[name]=value;},addEventListener(name,callback){this.events[name]=callback;},
  }]));
  const errors = [], saves = [];
  const context = {BookingState:state, window:{ApplianceServices:policy}, document:{getElementById:id=>elements[id]||null},
    normalizeBookingStep:value=>value, bookingDebug(){}, remainingBookingUnits:()=>40, MAX_BOOKING_UNITS:40,
    generateUniqueId:()=> 'new-service', isRepairBookingService:item=>item.type==='repair', bookingServiceIcon:()=> 'bi-tools',
    showError:message=>errors.push(message), updateSelectedServicesDisplay(){}, updatePricingDisplay(){},
    showAlert:message=>errors.push(message), showBookingToast(){}, DOM:{}, reconcileBookingScheduleAfterServiceChange(){},
    updateContinueButtonState(){}, updateRepairIssueDisplay(){}, saveBookingProgress:()=>saves.push(true)};
  vm.runInNewContext(['commitCoreAppliance','commitRepairAppliance','addServiceToBooking','getBookingStepIssue','getRestorableBookingStep','validateBookingData','syncCustomerServiceTypeChoice','updateSelectedServicesDisplay','removeService','addCurrentRepairItem'].map(declaration).join('\n'), context);
  return {state,elements,errors,saves,context};
}

test('customer selections allow multiple services in one category and reject combined categories', () => {
  assert.equal(policy.assertSingleServiceType([]), null);
  assert.equal(policy.assertSingleServiceType([core,{...core,id:'core-2'}]), 'core');
  assert.equal(policy.assertSingleServiceType([repair,{...repair,id:'repair-2'}]), 'repair');
  assert.equal(policy.assertSingleServiceType([{}]), 'core');
  for (const rows of [[core,repair],[repair,core],[{},repair],[{type:'mixed'}],[core,{type:'Repair_Service'}]]) {
    assert.throws(()=>policy.assertSingleServiceType(rows), {status:400,code:'MIXED_SERVICE_BOOKING_NOT_ALLOWED'});
  }
});

test('both appliance builders reject the other category without replacing the current selection', () => {
  const withCore = ui([core]);
  const beforeCore = structuredClone(withCore.state.selectedServices);
  assert.throws(()=>withCore.context.commitRepairAppliance(repair), /separately/);
  assert.deepEqual(withCore.state.selectedServices, beforeCore);
  assert.equal(withCore.saves.length, 0);
  const withRepair = ui([repair]);
  assert.throws(()=>withRepair.context.commitCoreAppliance([core]), /separately/);
  assert.deepEqual(withRepair.state.selectedServices, [repair]);
  assert.equal(withRepair.saves.length, 0);
});

test('the legacy service picker also refuses to append the other category', () => {
  const f = ui([core]);
  f.context.addServiceToBooking({_id:'repair-catalog',name:'Repair',type:'repair'},1);
  assert.match(f.errors[0], /separately/);
  assert.deepEqual(f.state.selectedServices,[core]);
  assert.equal(f.saves.length, 0);
});

test('same-category additions and edits remain available', () => {
  const f = ui([core]);
  f.context.commitCoreAppliance([{...core,id:'core-2'}]);
  assert.equal(f.state.selectedServices.length,2);
  const r = ui([repair]);
  r.context.commitRepairAppliance({...repair,model:'Updated model'},repair.id);
  assert.equal(r.state.selectedServices.length,1);
  assert.equal(r.state.selectedServices[0].model,'Updated model');
  r.context.commitRepairAppliance({...repair,id:'repair-2'});
  assert.equal(r.state.selectedServices.length,2);
});

test('choosing a category disables the other tab until all added services are removed', () => {
  const f = ui([core]);
  f.context.syncCustomerServiceTypeChoice();
  assert.equal(f.elements['repair-tab'].disabled,true);
  assert.equal(f.elements['core-tab'].disabled,false);
  assert.match(f.elements.serviceTypePolicy.textContent,/Core Services/);
  f.state.selectedServices=[]; f.context.syncCustomerServiceTypeChoice();
  assert.equal(f.elements['repair-tab'].disabled,false);
  assert.equal(f.elements['core-tab'].disabled,false);
  f.state.selectedServices=[repair]; f.context.syncCustomerServiceTypeChoice();
  assert.equal(f.elements['core-tab'].disabled,true);
  assert.equal(f.elements['repair-tab'].disabled,false);
});

test('Core and Repair each disable the opposite form and cancel attempts to open its tab', () => {
  for (const [selected,blocked] of [[core,'repair'],[repair,'core']]) {
    const f=ui([selected]); f.context.syncCustomerServiceTypeChoice();
    assert.equal(f.elements[`${blocked}ServiceSelection`].disabled,true);
    assert.equal(f.elements[`${selected.type}ServiceSelection`].disabled,false);
    assert.equal(f.elements[`${blocked}-services`].inert,true);
    assert.equal(f.elements[`${blocked}-tab`].attributes['aria-disabled'],'true');
    let prevented=false;
    f.elements[`${blocked}-tab`].events['show.bs.tab']({preventDefault(){prevented=true;}});
    assert.equal(prevented,true);
    f.state.selectedServices=[]; f.context.syncCustomerServiceTypeChoice();
    assert.equal(f.elements[`${blocked}ServiceSelection`].disabled,false);
    assert.equal(f.elements[`${blocked}-services`].inert,false);
    prevented=false;
    f.elements[`${blocked}-tab`].events['show.bs.tab']({preventDefault(){prevented=true;}});
    assert.equal(prevented,false);
  }
});

test('adding Core immediately explains the Repair block and removing only one of several Core services keeps it blocked', () => {
  const f = ui([]);
  f.context.commitCoreAppliance([core]);
  assert.equal(f.elements['repair-tab'].disabled, true);
  assert.equal(f.elements.repairServiceSelection.disabled, true);
  assert.equal(f.elements['repair-services'].inert, true);
  assert.match(f.elements['repair-tab'].description.textContent, /Blocked while Core/);
  f.context.commitCoreAppliance([{...core,id:'core-2'}]);
  f.context.removeService(core.id);
  assert.equal(f.elements['repair-tab'].disabled, true);
  f.context.removeService('core-2');
  assert.equal(f.elements['repair-tab'].disabled, false);
  assert.equal(f.elements.repairServiceSelection.disabled, false);
  assert.equal(f.elements['repair-services'].inert, false);
  assert.equal(f.elements['repair-tab'].description.textContent, 'Inspection, diagnosis and repairs');
});

test('adding Repair immediately blocks Core and removing it restores the Core description and controls', () => {
  const f = ui([]);
  f.context.commitRepairAppliance(repair);
  assert.equal(f.elements['core-tab'].disabled, true);
  assert.equal(f.elements.coreServiceSelection.disabled, true);
  assert.match(f.elements['core-tab'].description.textContent, /Blocked while Repair/);
  f.context.removeService(repair.id);
  assert.equal(f.elements['core-tab'].disabled, false);
  assert.equal(f.elements.coreServiceSelection.disabled, false);
  assert.equal(f.elements['core-tab'].description.textContent, 'Cleaning, installation and maintenance');
});

test('the older Repair form cannot add a repair or start identification when Core has already been added', () => {
  const f = ui([core]);
  f.context.repairNeedsIdentification = () => assert.fail('A blocked Repair form must not open identification');
  f.context.addCurrentRepairItem();
  assert.match(f.errors[0], /separately/);
  assert.deepEqual(f.state.selectedServices, [core]);
  assert.equal(f.saves.length, 0);
  const allowed = ui([repair]); let opened = false;
  allowed.context.repairNeedsIdentification = () => true;
  allowed.context.reviewRepairIdentification = () => { opened = true; };
  allowed.context.addCurrentRepairItem();
  assert.equal(opened, true);
});

test('older mixed drafts return to service selection and cannot continue or submit until corrected', () => {
  const f = ui([core,repair]), before = structuredClone(f.state.selectedServices);
  assert.equal(f.context.getRestorableBookingStep(),2);
  assert.equal(f.context.getBookingStepIssue(2).step,2);
  const result=f.context.validateBookingData();
  assert.equal(result.valid,false); assert.equal(result.step,2); assert.match(result.error,/separately/);
  f.context.syncCustomerServiceTypeChoice();
  assert.match(f.elements.serviceTypePolicy.textContent,/saved selection/);
  assert.deepEqual(f.state.selectedServices,before);
});

test('the older customer booking endpoint rejects mixed arrays and JSON before creating records', async () => {
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
    assert.equal(response.body.code,'MIXED_SERVICE_BOOKING_NOT_ALLOWED');
  }
});
