(function () {
  'use strict';
  let report = {}, page = 1;
  const size = 25, get = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value)||0);
  const date = value => value ? new Date(value).toLocaleDateString('en-PH',{timeZone:'Asia/Manila',month:'short',day:'numeric',year:'numeric'}) : 'Date unavailable';
  const title = value => String(value || 'unknown').replaceAll('_',' ').replaceAll('-',' ');
  const total = rows => rows.reduce((sum,row) => sum+Number(row.amount||0),0);
  const line = (label,value,featured) => `<div${featured?' class="rr-reconcile-result"':''}><span>${esc(label)}</span><strong>${esc(money(value))}</strong></div>`;
  function put(id,html) { const node=get(id); if(node)node.innerHTML=html; }
  function selectedRows() {
    const mode=get('revenueActivityView')?.value || 'completed';
    return mode==='unmatched' ? (report.activity?.payments||[]).filter(row=>row.group==='unmatched_work') : report.activity?.[mode]||[];
  }
  function renderActivity() {
    if(!report.activity)return;
    const mode=get('revenueActivityView')?.value || 'completed',r=report.reconciliation||{},rows=selectedRows();
    const notes={completed:'Completed in the selected dates. These rows add up to sales before refunds; subtract completed period refunds to reach the Completed sales card.',payments:'Actual collection and completed refund events in the selected dates. Refunds are negative. These rows add up to Payments after refunds.',requested:'Bookings and orders requested in the selected dates, plus completed counter sales. Pending and unfinished work is included here. Paid labels are compared with dated payment records.',unmatched:'Recorded cash whose booking or order cannot be found. These amounts remain in the payment total and require review; they are not counted as completed sales.'};
    if(get('revenueActivityNote'))get('revenueActivityNote').textContent=notes[mode];
    page=Math.min(Math.max(1,page),Math.max(1,Math.ceil(rows.length/size)));
    put('recentTransactionsBody',rows.length ? rows.slice((page-1)*size,page*size).map(row=>`<tr><td>${esc(date(row.date))}</td><td><span class="rr-type ${row.type==='order'?'order':row.type==='pos'?'pos':''}">${esc(row.type)}</span></td><td class="fw-bold">${esc(row.reference)}</td><td>${esc(row.customer)}</td><td>${esc(title(row.workStatus))}</td><td>${esc(title(row.status))}${row.paymentMismatch?'<small class="rr-ledger-warning">Paid label has no matching full payment</small>':''}</td><td>${esc(title(row.method))}</td><td>${esc(row.kind?title(row.kind):mode==='requested'?'Requested work':'Completed work')}</td><td class="text-end fw-bold">${esc(money(row.amount))}${mode==='requested'?`<small class="rr-ledger-note">Received ${esc(money(row.received))}<br>Unpaid ${esc(money(row.balance))}</small>`:''}</td></tr>`).join('') : '<tr><td colspan="9" class="rr-empty">No records for this view in the selected dates.</td></tr>');
    const label=mode==='completed'?'Completed sales before refunds':mode==='payments'?'Payments after refunds':mode==='requested'?'Requested work value':'Net cash linked to missing work';
    put('revenueActivityTotal',line(`${label} · all ${rows.length} records`,total(rows),true)+(mode==='completed'?line('Less completed period refunds',-Number(r.refunds||0))+line('Completed sales after refunds',r.netSales,true):''));
    if(get('revenueActivityPage'))get('revenueActivityPage').textContent=`Showing ${rows.length?(page-1)*size+1:0}–${Math.min(page*size,rows.length)} of ${rows.length}`;
    if(get('revenueActivityPrevious'))get('revenueActivityPrevious').disabled=page<=1;
    if(get('revenueActivityNext'))get('revenueActivityNext').disabled=page*size>=rows.length;
  }
  function render(A) {
    report=A||{};page=1;
    if(A.recognizedRevenue!==undefined || A.reconciliation?.netSales!==undefined) {
      const costs=A.reconciliation||{},direct=Number(costs.savedDirectCosts??A.totalPartsCost??0),expenses=Number(costs.approvedExpenses??A.approvedExpenseTotal??0),payroll=Number(costs.payroll??A.payrollCost??0);
      const detailed=[['Less saved service job costs',A.serviceDirectCost],['Less saved order costs',A.orderCost],['Less walk-in / POS product costs',A.posCost],['Less project materials',A.projectMaterialCost]];
      const splitAvailable=detailed.every(([,value])=>value!==undefined);
      put('profitReconciliation',`<h3>How this profit was calculated</h3><p>Costs use the selected dates. Approved expenses and approved or paid payroll can remain even when there are no completed bookings or orders.</p><div class="rr-reconcile-lines">${line('Completed sales after period refunds',costs.netSales??A.recognizedRevenue)}${splitAvailable?detailed.map(([label,value])=>line(label,-Number(value||0))).join(''):line('Less saved job and product costs',-direct)}${line('Less approved operating expenses',-expenses)}${line('Less approved and paid payroll',-payroll)}${line('Total costs deducted',direct+expenses+payroll,true)}${line('Profit after expenses',costs.operatingProfit??A.operatingProfit,true)}</div>`);
    }
    const r=A.reconciliation;if(!r)return;
    put('revenueBasis',`<strong>How to compare these tabs</strong><p>Sales uses work completed in the selected dates. Collections uses money received or refunded in those dates. Requested work and its unpaid balance use bookings and orders created in those dates.</p><span>${esc(date(A.reportPeriod?.startDate))} – ${esc(date(A.reportPeriod?.endDate))} · Philippine time</span>`);
    put('salesReconciliation',line('Services completed',A.salesView?.serviceRevenue)+line('Orders completed, including fees',A.salesView?.orderRevenue)+line('Counter sales completed',A.salesView?.posRevenue)+line('Sales before refunds',r.grossSales,true)+line('Less completed period refunds',-r.refunds)+line('Completed sales after refunds',r.netSales,true));
    put('cashReconciliation',`<h3>Where the recorded money belongs</h3><p>Payments can be deposits for unfinished work, money for older completed work, or records that need review. This is why collections can exceed completed sales.</p><div class="rr-reconcile-lines">${r.cashBreakdown.filter(row=>row.collections||row.refunds).map(row=>line(row.label,row.collections)).join('')}${line('Total payments received',r.grossCollections,true)}${line('Less completed period refunds',-r.refunds)}${line('Payments after refunds',r.netCollections,true)}</div>${r.unmatchedPaymentRecords?`<p class="rr-ledger-warning">${r.unmatchedPaymentRecords} payment records refer to missing work. ${esc(money(r.unmatchedCollections))} of collections needs review. Open Activity → Unmatched payments to inspect these records.</p>`:''}`);
    put('requestedReconciliation',`<h3>Payment coverage of requested work</h3><p>This balance follows the work requested in these dates. It is separate from cash received during the period. Each payment is applied only to its own booking or order.</p><div class="rr-reconcile-lines">${line('Requested work value',r.requestedValue)}${line('Payments applied to this work, up to the end date',r.appliedPayments)}${line('Unpaid balance on this work',r.unpaidBalance,true)}</div><p>${Number(r.paidCoveragePercent||0).toFixed(1)}% paid. Refunds do not reopen a settled charge.${r.paidStatusMismatchCount?` ${r.paidStatusMismatchCount} paid labels need checking against the payment ledger.`:''}</p>`);
    put('serviceReconciliation',line('Completed service sales before refunds',r.serviceGrossSales)+line('Less refunds on these completed services',-r.serviceRefundsOnCompletedWork)+line('Service sales used in the profit tables',r.serviceNetSales,true)+line('Saved service and project costs',r.serviceCosts)+`<p>Includes completed services only. Refunds of work completed outside these dates appear in Collections and in the overall period refund adjustment.</p>`);
    put('productReconciliation',line('Completed order items',r.orderItemSales)+line('Order fees and price adjustments',r.orderFeesAndAdjustments)+line('Completed order total',A.salesView?.orderRevenue,true)+line('Completed counter items',r.counterItemSales)+line('Other counter amounts and adjustments',r.counterFeesAndAdjustments)+line('Completed counter total',A.salesView?.posRevenue,true)+`<p>Product rankings show item sales. Delivery, installation and other adjustments are listed above. Period refunds appear in the Sales and Collections reconciliation.</p>`);
    renderActivity();
  }
  document.addEventListener('change',event=>{if(event.target.id==='revenueActivityView'){page=1;renderActivity();}});
  document.addEventListener('click',event=>{if(event.target.closest('#revenueActivityPrevious')){page--;renderActivity();}if(event.target.closest('#revenueActivityNext')){page++;renderActivity();}});
  window.RACSRevenueReconciliation={render,serviceCost:row=>Number(row.partsCost||0)+Number(row.consumablesCost||0)+Number(row.laborCost||0)+Number(row.localPurchaseCost||0),salesView:A=>A.salesView||A,monthKey:value=>new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,7)};
})();
