(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./repair-visit-payment'), require('./mixed-service-details'));
  else root.MixedServiceWorkspace = factory(root.RepairVisitPayment, root.MixedServiceDetails);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pricing, details) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const closed = new Set(['completed','cancelled','repair_declined']);
  const pendingCore = new Set(['pending','awaiting_assignment','assigned','accepted','scheduled','en_route','arrived']);
  const quoteStates = new Set(['staff_review','customer_review','approved','declined','completed']);
  const money = value => new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2}).format(Number(value)||0);
  const call = (name,...args) => name+'('+args.map(value=>JSON.stringify(value)).join(',')+')';
  function started(a) {
    const booking = a?.bookingId;
    if (!booking || typeof booking !== 'object' || a.status !== 'in_progress' || a.workUnavailable || booking.archivedAt || booking.isProject || booking.sourceOrderId) return false;
    const items = booking.services || [];
    return items.some(row=>row.type==='core') && items.some(row=>row.type==='repair');
  }
  function active(a) { return started(a) && a.crewRole !== 'support'; }
  function state(a) {
    const booking = a.bookingId, items = booking.services || [];
    const core = items.filter(row=>row.type==='core'), repairs = items.filter(row=>row.type==='repair');
    const units = repairs.flatMap(item=>(item.units||[]).map(unit=>({item,unit})));
    const coreDone = core.every(row=>closed.has(row.status));
    const repairDone = repairs.every(row=>closed.has(row.status));
    const allQuoted = booking.repairUnitTracking ? Boolean(booking.inspection?.completedAt) && ['pending','awaiting_customer','approved'].includes(booking.quotationReview?.status)
      && units.length>0 && units.every(({unit})=>quoteStates.has(unit.repairReview?.state) && unit.quotation)
      : Boolean(booking.inspection?.completedAt && booking.quotation);
    const decided = booking.repairUnitTracking ? booking.quotationReview?.status==='approved' && units.length>0 && units.every(({unit})=>['approved','declined','completed'].includes(unit.repairReview?.state))
      : ['approved','declined'].includes(booking.approval?.status);
    const repairStarted = Boolean(booking.repairExecution?.startedAt) || booking.status==='repair_in_progress' || repairs.some(row=>row.status==='repair_in_progress');
    const verified = !booking.repairUnitTracking || units.length>0 && units.every(({unit})=>['completed','declined'].includes(unit.repairReview?.state));
    return {booking,core,repairs,units,coreDone,repairDone,allQuoted,decided,repairStarted,verified,
      pending:core.filter(row=>pendingCore.has(row.status||'pending')),
      working:core.filter(row=>row.status==='in_progress'),held:core.some(row=>row.coreRepairHold?.state==='on_hold'||row.status==='on_hold'),
      bill:pricing.breakdown(booking)};
  }
  function next(a,page) {
    const s=state(a),bid=String(s.booking._id),aid=String(a._id);
    const corePage = {title:'Continue core services',description:'Finish the remaining booked core work before closing this visit.',label:'Go to core services',handler:call('switchDetailTab','core-service'),icon:'bi-arrow-right'};
    const repairPage = {title:'Continue repair services',description:'Inspect the repair appliances, record the quotation and agree on the next step with the customer.',label:'Go to repair services',handler:call('switchDetailTab','repair-service'),icon:'bi-arrow-right'};
    const collection = pricing.collection(s.booking);
    const settle = () => !collection.allowed ? {title:'Visit settlement is not ready',description:collection.reason}
      : !s.bill.ready ? {title:'Review repair decisions',description:'Every repair appliance needs a recorded quotation decision before the combined payment.',label:'Review inspection and quotation',handler:call('openRepairUnits','booking',bid),icon:'bi-clipboard-check'}
        : {title:s.bill.paidInFull?'Finish this visit':'Settle this visit',description:'One payment covers core services, repair inspection, approved repair and travel. Completion proof follows.',label:s.bill.paidInFull?'Submit completion proof':'Collect booking balance '+money(s.bill.amountDue),handler:s.bill.paidInFull?call('openProofModal',aid,a.customerName||'',a.serviceName||'',s.bill.total):'openCollectPaymentModal('+JSON.stringify(aid)+',window._detailAssignment,true)',icon:s.bill.paidInFull?'bi-camera':'bi-cash-coin'};
    if(s.coreDone&&s.repairDone)return settle();
    if(page==='overview')return s.coreDone?repairPage:corePage;
    if(page==='core-service'){
      if(s.pending.length)return {title:'Start the core services',description:'Start the booked core work here. Repair inspection is available in the Repair work tab.',label:'Start core work',handler:'startAllCoreWork('+JSON.stringify(bid)+',this)',icon:'bi-play-fill'};
      if(s.working.length)return {title:'Record completed core work',description:'Confirm only after the core services have been performed and checked.',label:s.working.length===1?'Complete core service':'Complete all core services',handler:'completeAllCoreWork('+JSON.stringify(bid)+',this)',icon:'bi-check-circle'};
      if(s.held)return {title:'Affected core work is paused',description:'Operations must review the service finding before this affected work can resume.'};
      return s.coreDone?repairPage:{title:'Core work needs review',description:'Review the appliance statuses or contact Operations before continuing.'};
    }
    if(page==='repair-service'){
      if(s.repairDone)return corePage;
      if(!s.allQuoted)return {title:'Inspect and quote each repair appliance',description:'Record findings, photos and the repair quotation in one guided form. Diagnostic help is inside the form.',label:'Inspect and quote',handler:call('openRepairUnits','booking',bid),icon:'bi-search'};
      if(!s.decided)return {title:'Record the customer repair decision',description:'Review the quoted repair with the customer, then choose repair today, another date or cancellation.',label:'Customer repair decision',handler:call('openRepairWorkflow',bid),icon:'bi-person-check'};
      if(!s.repairStarted)return {title:'Plan the approved repair',description:'Check parts, tools and the remaining visit time before starting the approved repair.',label:'Prepare repair work',handler:call('openRepairWorkflow',bid),icon:'bi-tools'};
      if(!s.verified)return {title:'Test and verify each repaired appliance',description:'Record the work performed, test results and customer confirmation. Report unresolved work for follow-up.',label:'Record repair test results',handler:call('openRepairUnits','booking',bid),icon:'bi-clipboard-check'};
      if(!s.coreDone)return {...corePage,title:'Finish the core services before closing',description:'Keep this repair in progress while the remaining core work is finished. The visit has one combined payment.'};
      if(!s.bill.ready)return settle();
      return {title:'Finish and document the repair',description:s.bill.paidInFull?'The booking payment is settled. Record repair completion and proof.':'Collect the combined booking balance once, then record repair completion and proof.',label:s.bill.paidInFull?'Submit repair completion proof':'Finish repair and collect '+money(s.bill.amountDue),handler:s.bill.paidInFull?call('completeRepair',bid):call('collectRepairPayment',bid,s.bill.amountDue),icon:s.bill.paidInFull?'bi-camera':'bi-cash-coin'};
    }
    return {title:'Visit records',description:'Use the Core work and Repair work tabs to continue this active visit.'};
  }
  function actions(a,page,extras='') {
    const step=next(a,page),s=state(a);
    const quoteLink=page==='repair-service' && !step.handler?.startsWith('openRepairUnits(')
      ? `<button type="button" class="btn btn-outline-secondary" onclick="${esc(call('openRepairUnits','booking',String(s.booking._id)))}">View inspection and quotation</button>`:'';
    return `<section class="mixed-work-actions" aria-label="Current mixed-service action"><div class="mixed-work-next"><div><span class="mixed-work-eyebrow">NEXT STEP</span><h3>${esc(step.title)}</h3><p>${esc(step.description)}</p></div>${step.handler?`<button type="button" class="btn btn-success mixed-work-primary" data-mixed-primary onclick="${esc(step.handler)}"><i class="bi ${esc(step.icon)}" aria-hidden="true"></i>${esc(step.label)}</button>`:''}</div>${extras||quoteLink?`<details class="mixed-work-tools"><summary>More visit options</summary><div>${quoteLink}${extras}</div></details>`:''}</section>`;
  }
  function repairSummary(a) {
    const s=state(a);
    const displayFinished = a.status === 'completed' ? s.repairs.every(item=>details.serviceState(item).finished) : s.repairDone;
    const declined = displayFinished && s.repairs.every(item=>['repair_declined','cancelled'].includes(item.status) || details.serviceState(item).label === 'Declined');
    const current=displayFinished?3:s.repairStarted||s.decided?2:s.allQuoted?1:0;
    const states={pending:'Inspection needed',staff_review:'Quotation recorded',customer_review:'Awaiting customer decision',approved:'Repair approved',declined:'Repair declined',completed:'Repair completed'};
    const description=a.status==='completed'?'Review the recorded inspection, quotation and outcome for each appliance.':'Follow the next step below. Each appliance keeps its own findings and quotation.';
    const completionNote=a.status==='completed'?(declined?'The customer declined the repair. This visit is completed.':'Repair work and testing are complete.'):(declined?'The repair was declined after inspection.':'Repair work is complete.')+' Complete any remaining core services to finish the visit.';
    return `<section class="mixed-repair-work" aria-label="Repair work progress"><header><span class="mixed-work-eyebrow">REPAIR WORK</span><h3>Inspection, decision and repair</h3><p>${description}</p></header><ol class="mixed-work-steps">${['Inspect and quote','Customer decision',declined?'Repair declined':'Repair and proof'].map((label,index)=>`<li ${current===index?'aria-current="step"':''} data-state="${declined&&index===2?'skipped':index<current?'done':index===current?'current':'waiting'}"><span>${declined&&index===2?'&mdash;':index<current?'&#10003;':index+1}</span>${label}</li>`).join('')}</ol><div class="mixed-repair-appliances">${s.repairs.map((item,index)=>{
      const units=item.units?.length?item.units:[{label:item.name,repairReview:{state:closed.has(item.status)?item.status==='completed'?'completed':'declined':'pending'}}];
      return units.map((unit,unitIndex)=>{
        const findings=unit.inspection?.findings||unit.diagnosis?.summary||item.diagnosisNotes;
        const quote=unit.quotation||item.quotation;
        const status=unit.repairVerification?.outcome==='follow_up_required'?'Follow-up required':states[unit.repairReview?.state]||String(item.status||'Inspection needed').replace(/_/g,' ');
        return `<article><div><h4>${esc(unit.label||item.name||'Repair appliance')} ${Number(item.quantity)>1?unitIndex+1:''}</h4><p>${esc([item.brand,item.applianceTypeName||item.airconTypeName,item.hp?item.hp+' HP':''].filter(Boolean).join(' / '))}</p></div><span class="mixed-work-status">${esc(status)}</span>${item.problemDescription||item.repairIssue?`<p class="mixed-repair-issue">${esc(item.problemDescription||item.repairIssue)}</p>`:''}${findings?`<p class="mixed-repair-record"><strong>Recorded findings</strong>${esc(findings)}</p>`:''}${quote?`<p class="mixed-repair-record"><strong>Recorded quotation</strong>${money(quote.totalCost)}</p>`:''}</article>`;
      }).join('');
    }).join('')}</div>${displayFinished?`<p class="mixed-work-note">${completionNote}</p>`:''}</section>`;
  }
  return {started,active,state,next,actions,repairSummary};
});
