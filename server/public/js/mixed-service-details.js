(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./repair-visit-payment'));
  else root.MixedServiceDetails=factory(root.RepairVisitPayment);
})(typeof globalThis!=='undefined'?globalThis:this,function(pricing){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=value=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2}).format(Number(value)||0);
  const names={pending:'Pending',pending_acceptance:'Awaiting acceptance',accepted:'Accepted',assigned:'Assigned',awaiting_assignment:'Awaiting assignment',en_route:'En route','on-the-way':'En route',arrived:'On site',on_site:'On site',in_progress:'In progress','in-progress':'In progress',inspection_pending:'Inspection needed',inspection_scheduled:'Inspection scheduled',inspection_in_progress:'Inspecting',inspection_completed:'Inspection recorded',repair_approved:'Repair approved',repair_scheduled:'Repair scheduled',ready_for_repair:'Ready for repair',repair_in_progress:'Repair in progress',payment_pending:'Awaiting settlement',completed:'Completed',repair_completed:'Completed',repair_declined:'Declined',cancelled:'Cancelled',on_hold:'Paused',staff_review:'Quotation recorded',customer_review:'Awaiting customer decision',approved:'Repair approved',declined:'Declined'};
  const label=value=>names[value]||String(value||'Pending').replace(/_/g,' ');
  function serviceState(item){
    if(['cancelled','repair_declined'].includes(item.status))return{label:label(item.status),tone:'done',finished:true};
    const units=item.type==='repair'?(item.units||[]):[];
    if(units.length){
      const reviews=units.map(unit=>unit.repairReview?.state||'pending');
      if(units.some(unit=>unit.repairVerification?.outcome==='follow_up_required'))return{label:'Follow-up required',tone:'review',finished:false};
      if(reviews.every(value=>['completed','declined'].includes(value)))return{label:reviews.every(value=>value==='declined')?'Declined':reviews.every(value=>value==='completed')?'Completed':'Repair work closed',tone:'done',finished:true};
      if(item.status==='completed')return{label:'Completion needs review',tone:'review',finished:false};
      if(item.status==='repair_in_progress')return{label:'Repair in progress',tone:'active',finished:false};
      for(const value of ['approved','customer_review','staff_review'])if(reviews.includes(value))return{label:label(value),tone:value==='approved'?'active':'waiting',finished:false};
    }
    const status=item.status||'pending';
    return{label:label(status),tone:['completed','repair_declined','cancelled'].includes(status)?'done':['in_progress','repair_in_progress','inspection_in_progress'].includes(status)?'active':status==='on_hold'?'review':'waiting',finished:['completed','repair_declined','cancelled'].includes(status)};
  }
  function tabState(a,type){
    const items=(a.bookingId?.services||[]).filter(item=>item.type===type);
    if(!items.length)return null;
    const states=items.map(serviceState);
    if(states.every(row=>row.finished))return{badge:states.every(row=>row.label==='Declined')?'Declined':'Complete',cls:'badge-done',attention:false};
    if(a.status==='completed')return{badge:'Review',cls:'badge-pending',attention:true};
    if(states.some(row=>row.tone==='active'))return{badge:'Active',cls:'badge-active',attention:false};
    if(states.some(row=>row.tone==='review'))return{badge:'Review',cls:'badge-pending',attention:true};
    return{badge:type==='repair'?'Next step':'Ready',cls:'badge-pending',attention:true};
  }
  function date(value){const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toLocaleString('en-PH',{timeZone:'Asia/Manila',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';}
  function progress(a){
    const b=a.bookingId||{},items=b.services||[];
    const started=['in_progress','completed'].includes(a.status)||items.some(item=>['in_progress','inspection_in_progress','repair_in_progress','payment_pending','completed'].includes(item.status));
    const preparing=['pending_acceptance','accepted'].includes(a.status)&&!started;
    const steps=preparing?[
      {key:'accepted',label:'Technician Accepts',icon:'bi-check-lg'},
      {key:'ai_review',label:'Review AI Diagnosis',icon:'bi-clipboard2-pulse'},
      {key:'daily_prep',label:'Daily Preparation',icon:'bi-briefcase'},
      {key:'en_route',label:'En Route',icon:'bi-sign-turn-right'}
    ]:[
      {key:'accepted',label:'Accepted',icon:'bi-check-lg'},
      {key:'en_route',label:'En Route',icon:'bi-sign-turn-right'},
      {key:'on_site',label:'Arrived',icon:'bi-geo-alt'},
      {key:'in_progress',label:'Service Work',icon:'bi-layers'},
      {key:'completed',label:'Done',icon:'bi-check-circle'}
    ];
    const finished=items.length>0&&items.every(item=>serviceState(item).finished);
    const current=preparing?(a.status==='pending_acceptance'?'accepted':b.technicianAssistant?.verifiedByTechnician?'daily_prep':'ai_review')
      :finished?'completed':['in_progress','completed'].includes(a.status)?'in_progress':a.status==='on_site'?'on_site':a.status==='en_route'?'en_route':'accepted';
    const action=current==='ai_review'?{t:'Review AI diagnosis',s:'Check the preliminary findings before preparing for the visit.',icon:'bi-clipboard2-pulse'}
      :current==='daily_prep'&&!a.equipmentCheckedOut?{t:'Prepare equipment',s:'Review and confirm the shared daily kit before departure.',icon:'bi-briefcase'}:null;
    return {steps,current,index:steps.findIndex(step=>step.key===current),action};
  }
  function disclosure(title,body,extra=''){
    return body?`<details class="booking-detail-card mixed-visit-extra" ${extra}><summary class="booking-detail-card-head"><span class="booking-detail-card-title">${esc(title)}</span><i class="bi bi-chevron-down" aria-hidden="true"></i></summary><div class="booking-detail-card-body">${body}</div></details>`:'';
  }
  function card(title,icon,body,attributes='',aside=''){
    return `<section class="booking-detail-card" ${attributes}><div class="booking-detail-card-head"><h6 class="booking-detail-card-title"><i class="bi ${icon}" aria-hidden="true"></i>${title}</h6>${aside}</div><div class="booking-detail-card-body">${body}</div></section>`;
  }
  function info(title,icon,value){
    return `<div class="booking-info-row"><div class="booking-info-icon"><i class="bi ${icon}" aria-hidden="true"></i></div><div><div class="booking-info-label">${title}</div><div class="booking-info-value">${esc(value)}</div></div></div>`;
  }
  function moneyRow(title,amount,total=false){
    return `<div class="booking-money-row${total?' total':''}"><span>${esc(title)}</span><strong>${money(amount)}</strong></div>`;
  }
  function render(a,options={}){
    const b=a.bookingId||{},items=b.services||[];
    const bill=pricing.breakdown(b);
    const reference=b.bookingReference||options.reference||'Booking';
    const customer=a.customerName||b.customer?.name||'Customer';
    const phone=a.customerPhone||b.customer?.phone||'';
    const phoneLink=String(phone).replace(/[^+\d]/g,'');
    const address=a.customerLocation?.address||a.location?.address||b.customerLocation?.address||b.location?.address||b.address||a.address||'Address to be confirmed';
    const destination=options.hasCoords?`${Number(options.lat)},${Number(options.lng)}`:address;
    const directions='https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(destination);
    const method=b.paymentMethod||a.paymentMethod;
    const methodLabel=method==='cash_after_service'?'100% CASH AFTER SERVICE':method==='cod'?'CASH AFTER SERVICE':String(method||'To be confirmed').replace(/_/g,' ').toUpperCase();
    const status=label(a.status||b.status),dateTime=options.dateTime||'Schedule to be confirmed';
    const services=items.map(item=>{
      const state=serviceState(item),isRepair=item.type==='repair';
      const meta=[isRepair?'Repair':'Core',item.brand,item.applianceTypeName||item.airconTypeName,item.hpDescription||(item.hp?item.hp+' HP':''),item.model,'Qty '+(Number(item.quantity)||1),Number(item.duration)>0?item.duration+' min':''].filter(Boolean).join(' / ');
      const initial=item.initialCost!=null||item.unitPrice!=null?Number(item.initialCost??item.unitPrice)*Number(item.quantity||1):Number(item.totalPrice||0);
      const unitPrices=(item.units||[]).filter(unit=>['approved','completed'].includes(unit.repairReview?.state)).reduce((sum,unit)=>sum+Number(unit.quotation?.totalCost||0),0);
      const issue=item.problemDescription||item.repairIssue;
      return `<article class="booking-service-row mixed-visit-service"><div class="booking-service-icon"><i class="bi ${isRepair?'bi-wrench-adjustable':'bi-gear-wide-connected'}" aria-hidden="true"></i></div><div class="mixed-service-description"><div class="booking-service-name">${esc(item.name||'Service')}</div><div class="booking-service-meta">${esc(meta)}</div><span class="mixed-service-status" data-tone="${state.tone}">${esc(state.label)}</span>${issue?`<p class="booking-service-meta mixed-service-problem"><strong>Reported problem:</strong> ${esc(issue)}</p>`:''}</div><div class="booking-service-amount">${isRepair?'<span class="mixed-service-fee-label">Inspection fee</span>':''}<strong>${money(initial)}</strong>${unitPrices>0?`<span class="mixed-service-fee-label">Approved repair</span><strong>${money(unitPrices)}</strong>`:''}</div></article>`;
    }).join('');
    const equipment=(a.equipmentItems||[]).map(row=>`<li><span>${esc(row.equipmentName||row.name||'Equipment')}${Number(row.quantity)>1?' / Qty '+Number(row.quantity):''}</span><span>${esc(label(row.status))}</span></li>`).join('');
    const parts=(a.reservedParts||[]).map(row=>`<li><span>${esc(row.itemName||row.toolId?.itemName||'Part')} / Qty ${Number(row.quantity)||1}</span><span>${esc(label(row.status))}</span></li>`).join('');
    const notes=Array.isArray(a.notes)&&a.notes.length?a.notes:Array.isArray(b.statusHistory)?b.statusHistory:[];
    const activity=notes.map(row=>`<li><p>${esc(row.text||row.reason||label(row.toStatus))}</p><small>${esc([row.byName||row.changedByName||'System',date(row.createdAt||row.timestamp)].filter(Boolean).join(' / '))}</small></li>`).join('');
    const needsReview=a.status==='completed'&&items.some(item=>!serviceState(item).finished);
    const contacts=`<div class="booking-contact-actions">${phoneLink?`<a class="booking-contact-action" href="tel:${esc(phoneLink)}"><i class="bi bi-telephone" aria-hidden="true"></i>Call</a><a class="booking-contact-action" href="sms:${esc(phoneLink)}"><i class="bi bi-chat-dots" aria-hidden="true"></i>Text</a>`:''}<a class="booking-contact-action" href="${esc(directions)}" target="_blank" rel="noopener noreferrer"><i class="bi bi-sign-turn-right" aria-hidden="true"></i>Directions</a></div>`;
    const customerCard=card('Customer &amp; Service Location','bi-geo-alt-fill',`<div class="booking-info-list">${info('Customer','bi-person',customer+(phone?' / '+phone:''))}${info('Service address','bi-pin-map',address)}${info('Appointment schedule','bi-calendar3',dateTime)}${info('Priority','bi-award',String(a.priority||b.priority||'normal').toUpperCase())}</div>${contacts}`,'aria-label="Customer and location"');
    const paymentBody=`<div class="booking-money-row"><span>Payment method</span><strong>${esc(methodLabel)}</strong></div>${bill.lines.filter(row=>row.amount>0).map(row=>moneyRow(row.label,row.amount)).join('')}${moneyRow('Total fee',bill.total,true)}${moneyRow('Recorded payment',bill.amountPaid)}${moneyRow('Balance remaining',bill.amountDue)}`;
    const paymentCard=card('Payment Snapshot','bi-receipt',paymentBody,'aria-label="Visit payment"',`<span class="booking-payment-status ${bill.paidInFull?'settled':'unsettled'}">${bill.paidInFull?'Paid':'Balance due'}</span>`);
    return `<div class="booking-order-overview mixed-visit-overview">
      ${options.emergency||''}
      <section class="booking-detail-overview"><div class="booking-detail-overview-main"><div class="booking-detail-overview-icon"><i class="bi bi-layers" aria-hidden="true"></i></div><div><div class="booking-detail-eyebrow">Assigned booking</div><h4>${items.length} Services</h4><p>Booking #${esc(reference)} &middot; MIXED SERVICE - CORE + REPAIR</p></div></div><div class="booking-detail-total"><span>Service total</span><strong>${money(bill.total)}</strong></div></section>
      <div class="booking-detail-summary"><div class="booking-summary-cell"><span>Schedule</span><strong>${esc(dateTime)}</strong></div><div class="booking-summary-cell"><span>Service type</span><strong>Mixed Service</strong></div><div class="booking-summary-cell"><span>Customer</span><strong>${esc(customer)}</strong></div><div class="booking-summary-cell"><span>Current status</span><strong>${esc(status)}</strong></div></div>
      ${needsReview?'<p class="alert alert-warning mixed-visit-review" role="status">Repair testing or service completion still needs review. Ask Operations to review this completed visit.</p>':''}
      <div class="booking-detail-grid mixed-service-detail-grid"><div class="booking-detail-column">${customerCard}${options.instructions||''}${card('Booked Services','bi-list-check',services,'aria-label="Booked services" data-mixed-services',`<span class="booking-team-count">${items.length} services</span>`)}<div class="mixed-visit-extras">${disclosure('Assigned equipment'+(equipment?' ('+(a.equipmentItems||[]).length+')':''),equipment?'<ul class="mixed-visit-record-list">'+equipment+'</ul>':'<p>No equipment records for this visit.</p>')}${parts?disclosure('Reserved parts','<ul class="mixed-visit-record-list">'+parts+'</ul>'):''}${activity?disclosure('Activity ('+notes.length+')','<ol class="mixed-visit-activity">'+activity+'</ol>'):''}</div></div><div class="booking-detail-column mixed-service-summary">${options.preparation||''}${options.team||''}${paymentCard}</div></div>
    </div>`;
  }
  return{render,serviceState,tabState,progress};
});
