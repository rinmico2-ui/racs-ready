'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const details=require('../public/js/mixed-service-details');
const workspace=require('../public/js/mixed-service-workspace');
const instructions=require('../public/js/special-instructions');
function fixture(){return {_id:'assignment',status:'completed',customerName:'Abby <Customer>',customerPhone:'09123456789',priority:'normal',notes:[{text:'Assigned <script>bad()</script>',byName:'Admin',createdAt:'2026-10-22T12:00:00Z'}],equipmentItems:[{name:'Leak detector',status:'checked_out'}],bookingId:{bookingReference:'RACS-MIXED-TEST',serviceType:'mixed',repairUnitTracking:true,status:'completed',amountPaid:5090,travelFare:390,quotation:{totalCost:800},paymentMethod:'cash_after_service',location:{address:'Long service address, Nueva Ecija'},services:[{type:'core',name:'Aircon Installation',quantity:1,unitPrice:3500,totalPrice:3500,status:'completed'},{type:'repair',name:'Split Type Repair',quantity:1,initialCost:400,totalPrice:1200,status:'repair_approved',problemDescription:'Does not <cool>',units:[{unitIndex:1,repairReview:{state:'completed'},repairVerification:{outcome:'resolved'},quotation:{totalCost:800}}]}]}};}
test('mixed details keep one service list and one payment summary without duplicate service snapshots',()=>{
  const a=fixture(),html=details.render(a,{instructions:instructions.renderBooking({paymentNotes:'DEMO <only>'}),dateTime:'October 22, 2026 at 9 PM'});
  assert.equal((html.match(/aria-label="Booked services"/g)||[]).length,1);
  assert.equal((html.match(/aria-label="Visit payment"/g)||[]).length,1);
  assert.equal((html.match(/aria-label="Special instructions"/g)||[]).length,1);
  assert.doesNotMatch(html,/Service Work Command Center|Services in this Assignment|Service Snapshot/);
  assert.match(html,/RACS-MIXED-TEST/);assert.match(html,/October 22, 2026 at 9 PM/);
  assert.match(html,/Abby &lt;Customer&gt;/);assert.match(html,/Does not &lt;cool&gt;/);
  assert.doesNotMatch(html,/<script>/);assert.match(html,/Assigned &lt;script&gt;/);
  assert.match(html,/href="tel:09123456789"/);assert.match(html,/href="sms:09123456789"/);
});
test('completed unit verification takes priority over a stale repair-approved item status',()=>{
  const a=fixture(),repair=a.bookingId.services[1];
  assert.deepEqual(details.serviceState(repair),{label:'Completed',tone:'done',finished:true});
  assert.equal(details.tabState(a,'repair').badge,'Complete');
  assert.doesNotMatch(details.render(a),/needs review|repair approved/i);
  assert.equal((workspace.repairSummary(a).match(/data-state="done"/g)||[]).length,3);
  repair.units[0].inspection={findings:'Faulty <sensor>'};
  const summary=workspace.repairSummary(a);
  assert.match(summary,/Faulty &lt;sensor&gt;/);assert.match(summary,/Recorded quotation/);
  assert.doesNotMatch(summary,/Complete any remaining core|Follow the next step/);
});
test('completed parent never hides unresolved appliance work or required follow-up',()=>{
  const a=fixture(),repair=a.bookingId.services[1],unit=repair.units[0];
  unit.repairReview.state='approved';
  assert.equal(details.serviceState(repair).finished,false);
  assert.equal(details.tabState(a,'repair').badge,'Review');
  assert.match(details.render(a),/still needs review/);
  repair.status='completed';assert.equal(details.serviceState(repair).label,'Completion needs review');
  unit.repairReview.state='completed';unit.repairVerification.outcome='follow_up_required';
  assert.equal(details.serviceState(repair).label,'Follow-up required');
  assert.doesNotMatch(workspace.repairSummary(a),/<li[^>]+data-state="done"[^>]*>.*?<li[^>]+data-state="done"[^>]*>.*?<li[^>]+data-state="done"/);
  repair.status='cancelled';assert.equal(details.serviceState(repair).label,'Cancelled');
  assert.equal(details.serviceState(repair).finished,true);
});
test('service fees and recorded payments use the existing combined visit breakdown once',()=>{
  const html=details.render(fixture());
  assert.match(html,/Inspection fee<\/span><strong>[^<]*400\.00/);
  assert.match(html,/Approved repair<\/span><strong>[^<]*800\.00/);
  assert.match(html,/Total fee<\/span><strong>[^<]*5,090\.00/);
  assert.match(html,/Recorded payment<\/span><strong>[^<]*5,090\.00/);
  assert.match(html,/Balance remaining<\/span><strong>[^<]*0\.00/);
  assert.match(html,/>Paid<\/span>/);
  assert.doesNotMatch(html,/>Collect payment</);
});
test('equipment and activity remain accessible in collapsed disclosures',()=>{
  const html=details.render(fixture());
  assert.equal((html.match(/<details class="booking-detail-card mixed-visit-extra"/g)||[]).length,2);
  assert.doesNotMatch(html,/<details[^>]*\bopen\b/);
  assert.match(html,/Assigned equipment \(1\)/);assert.match(html,/Activity \(1\)/);
  assert.match(html,/Leak detector/);assert.match(html,/checked out/);
});
test('mixed preparation progress reflects AI review and actual kit confirmation',()=>{
  const a=fixture();a.status='pending_acceptance';a.bookingId.services.forEach(item=>{item.status='assigned';item.units=[];});
  assert.equal(details.progress(a).current,'accepted');
  a.status='accepted';assert.equal(details.progress(a).current,'ai_review');
  a.bookingId.technicianAssistant={verifiedByTechnician:true};
  assert.equal(details.progress(a).current,'daily_prep');
  assert.equal(details.progress(a).action.t,'Prepare equipment');
  a.equipmentCheckedOut=true;
  assert.equal(details.progress(a).action,null,'Confirmed equipment uses the shared Equipment prepared message');
  assert.deepEqual(details.progress(a).steps.map(step=>step.key),['accepted','ai_review','daily_prep','en_route']);
});
test('work progress retains the mixed execution phases and only finishes when each service is closed',()=>{
  const a=fixture();a.status='in_progress';a.bookingId.services[1].units[0].repairReview.state='approved';
  assert.equal(details.progress(a).current,'in_progress');
  assert.deepEqual(details.progress(a).steps.map(step=>step.key),['accepted','en_route','on_site','in_progress','completed']);
  a.bookingId.services[1].units[0].repairReview.state='completed';
  assert.equal(details.progress(a).current,'completed');
  a.bookingId.services[1].units[0].repairVerification.outcome='follow_up_required';
  assert.equal(details.progress(a).current,'in_progress');
});
