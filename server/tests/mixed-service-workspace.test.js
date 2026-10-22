'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const workspace=require('../public/js/mixed-service-workspace');
const policy=require('../public/js/core-repair-policy');
const id=number=>String(number).padStart(24,'0');
function fixture(){return {_id:id(1),status:'in_progress',crewRole:'primary',serviceType:'mixed',customerName:'Customer',bookingId:{_id:id(2),serviceType:'mixed',status:'in-progress',repairUnitTracking:true,travelFare:390,amountPaid:0,
  services:[{_id:id(3),type:'core',name:'Cleaning',status:'arrived',quantity:1,unitPrice:1000},{_id:id(4),type:'repair',name:'Split type repair',status:'arrived',quantity:1,unitPrice:400,units:[{unitIndex:1,repairReview:{state:'pending'}}]}]}};}
function quote(a,status='pending',review='staff_review'){
  const b=a.bookingId;b.inspection={completedAt:'2026-10-22T12:00:00Z'};b.quotationReview={status};
  b.services[1].units[0].repairReview.state=review;b.services[1].units[0].quotation={parts:[],laborCost:500,totalCost:500};
  b.quotation={totalCost:status==='approved'?500:0};
}
test('organized work actions activate only after Start Work for the primary technician on a mixed service',()=>{
  const a=fixture();assert.equal(workspace.active(a),true);
  for(const status of ['pending_acceptance','accepted','en_route','on_site','completed'])assert.equal(workspace.active({...a,status}),false);
  assert.equal(workspace.active({...a,crewRole:'support'}),false);
  assert.equal(workspace.started({...a,crewRole:'support'}),true);
  assert.equal(workspace.active({...a,workUnavailable:true}),false);
  assert.equal(workspace.active({...a,bookingId:{...a.bookingId,isProject:true}}),false);
  a.bookingId.services.pop();assert.equal(workspace.active(a),false);
});
test('core work has one primary action and changes to repair navigation after completion',()=>{
  const a=fixture();assert.match(workspace.next(a,'core-service').handler,/^startAllCoreWork/);
  let html=workspace.actions(a,'core-service');assert.equal((html.match(/data-mixed-primary/g)||[]).length,1);assert.doesNotMatch(html,/openRepairUnits|Repair found/);
  a.bookingId.services[0].status='in_progress';assert.match(workspace.next(a,'core-service').handler,/^completeAllCoreWork/);
  a.bookingId.services[0].status='completed';assert.match(workspace.next(a,'core-service').handler,/switchDetailTab\("repair-service"\)/);
});
test('repair actions follow submitted inspection, customer decision, work plan, verification and one combined collection',()=>{
  const a=fixture(),repair=a.bookingId.services[1],unit=repair.units[0];
  assert.match(workspace.next(a,'repair-service').handler,/openRepairUnits/);
  unit.repairReview.state='staff_review';unit.quotation={totalCost:500};
  assert.match(workspace.next(a,'repair-service').handler,/openRepairUnits/,'A saved draft still needs submission');
  quote(a);assert.match(workspace.next(a,'repair-service').handler,/openRepairWorkflow/);
  a.bookingId.quotationReview.status='rejected';assert.match(workspace.next(a,'repair-service').handler,/openRepairUnits/);
  quote(a,'approved','approved');assert.match(workspace.next(a,'repair-service').label,/Prepare repair/);
  repair.status='repair_in_progress';a.bookingId.repairExecution={startedAt:'2026-10-22T12:30:00Z'};
  assert.match(workspace.next(a,'repair-service').label,/test results/,'Repair verification comes before collection');
  unit.repairVerification={outcome:'follow_up_required'};assert.match(workspace.next(a,'repair-service').handler,/openRepairUnits/);
  unit.repairReview.state='completed';unit.repairVerification={outcome:'resolved'};
  assert.match(workspace.next(a,'repair-service').handler,/switchDetailTab\("core-service"\)/);
  a.bookingId.services[0].status='completed';assert.match(workspace.next(a,'repair-service').handler,/collectRepairPayment/);
  a.bookingId.amountPaid=2290;assert.match(workspace.next(a,'repair-service').handler,/^completeRepair/);
  repair.status='completed';assert.match(workspace.next(a,'overview').handler,/openProofModal/);
});
test('held appliances do not prevent work on other core appliances and final collection stays blocked',()=>{
  const a=fixture(),b=a.bookingId;const first=b.services[0];first.status='on_hold';first.coreRepairHold={state:'on_hold'};
  assert.equal(workspace.next(a,'core-service').handler,undefined);
  b.services.push({...first,_id:id(5),status:'arrived',coreRepairHold:undefined});assert.match(workspace.next(a,'core-service').handler,/startAllCoreWork/);
  b.services[2].status='in_progress';assert.match(workspace.next(a,'core-service').handler,/completeAllCoreWork/);
});
test('secondary tools stay in a collapsed group, appliance text is escaped and only the current action is primary',()=>{
  const a=fixture();a.bookingId.services[1].problemDescription='<img src=x onerror=alert(1)>';
  const html=workspace.actions(a,'repair-service','<button>Continue on another visit</button>');
  assert.equal((html.match(/data-mixed-primary/g)||[]).length,1);assert.match(html,/<details class="mixed-work-tools">/);assert.doesNotMatch(html,/<details[^>]*\bopen\b/);
  const summary=workspace.repairSummary(a);assert.doesNotMatch(summary,/<img/);assert.match(summary,/&lt;img/);assert.doesNotMatch(summary,/<button/);
});
test('Repair found is removed from core and mixed jobs while recorded findings remain accessible',()=>{
  const a=fixture();assert.equal(policy.isCoreOrigin(a.bookingId),false);
  const window={CoreRepairPolicy:policy};vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/core-repair-findings'),'utf8'),{window,Map,Intl});
  assert.equal(window.CoreRepairFindings.actions(a),'');
  a.bookingId.services.pop();a.bookingId.serviceType='core';assert.equal(window.CoreRepairFindings.actions(a),'');
  a.bookingId.services.push({_id:id(6),type:'repair',discoveredDuringService:{sourceServiceItemId:id(3)}});a.bookingId.serviceType='mixed';
  assert.equal(policy.isCoreOrigin(a.bookingId),true);assert.match(window.CoreRepairFindings.actions(a),/Repair findings/);
});

test('declined repair is shown as skipped work and still uses one combined visit collection',()=>{
  const a=fixture();quote(a,'approved','declined');a.bookingId.quotation.totalCost=0;
  a.bookingId.services[1].status='repair_declined';
  assert.match(workspace.repairSummary(a),/data-state="skipped"/);
  assert.match(workspace.next(a,'repair-service').handler,/switchDetailTab\("core-service"\)/);
  a.bookingId.services[0].status='completed';
  assert.match(workspace.next(a,'repair-service').handler,/openCollectPaymentModal/);
  assert.doesNotMatch(workspace.next(a,'repair-service').handler,/completeRepair/);
});
