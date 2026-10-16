(function () {
  'use strict';
  let report = {}, page = 1, costPage = 1;
  const size = 25, get = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value)||0);
  const date = value => value ? new Date(value).toLocaleDateString('en-PH',{timeZone:'Asia/Manila',month:'short',day:'numeric',year:'numeric'}) : 'Date unavailable';
  const title = value => String(value || 'unknown').replaceAll('_',' ').replaceAll('-',' ');
  const total = rows => rows.reduce((sum,row) => sum+Number(row.amount||0),0);
  const line = (label,value,featured) => `<div${featured?' class="rr-reconcile-result"':''}><span>${esc(label)}</span><strong>${esc(money(value))}</strong></div>`;
  const savedMoney = value => value==null?'Unavailable':esc(money(value));
  const priceMetrics = rows => `<dl class="rr-product-pricing">${rows.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
  function productPrices(item) {
    return priceMetrics([['Quantity',`${Number(item.quantity).toLocaleString('en-PH')} ${esc(item.unit||'units')}`],['Bought price / unit',savedMoney(item.unitCost)],
      ['Selling price / unit',savedMoney(item.sellingPrice)],['Item sales',savedMoney(item.salesAmount)],['Product cost',savedMoney(item.amount)],['Item gross profit',savedMoney(item.grossProfit)]]);
  }
  function put(id,html) { const node=get(id); if(node)node.innerHTML=html; }
  function selectedRows() {
    const mode=get('revenueActivityView')?.value || 'completed';
    return mode==='unmatched' ? (report.activity?.payments||[]).filter(row=>row.group==='unmatched_work') : report.activity?.[mode]||[];
  }
  function renderActivity() {
    if(!report.activity)return;
    const mode=get('revenueActivityView')?.value || 'completed',r=report.reconciliation||{},rows=selectedRows();
    const notes={completed:'Finished in the selected dates. These rows add up to sales before refunds. Subtract refunds sent in these dates to reach the Completed sales card.',payments:'Customer payments and refunds sent in the selected dates. Refunds are negative amounts. These rows add up to the Money received card.',requested:'Bookings and orders requested in the selected dates, plus completed counter sales. Pending and unfinished work is included here. Paid labels are compared with dated payment records.',unmatched:'Recorded cash whose booking or order cannot be found. These amounts remain in the payment total and require review; they are not counted as completed sales.'};
    if(get('revenueActivityNote'))get('revenueActivityNote').textContent=notes[mode];
    page=Math.min(Math.max(1,page),Math.max(1,Math.ceil(rows.length/size)));
    put('recentTransactionsBody',rows.length ? rows.slice((page-1)*size,page*size).map(row=>`<tr><td>${esc(date(row.date))}</td><td><span class="rr-type ${row.type==='order'?'order':row.type==='pos'?'pos':''}">${esc(row.type)}</span></td><td class="fw-bold">${esc(row.reference)}</td><td>${esc(row.customer)}</td><td>${esc(title(row.workStatus))}</td><td>${esc(title(row.status))}${row.paymentMismatch?'<small class="rr-ledger-warning">Paid label has no matching full payment</small>':''}</td><td>${esc(title(row.method))}</td><td>${esc(row.kind?title(row.kind):mode==='requested'?'Requested work':'Completed work')}</td><td class="text-end fw-bold">${esc(money(row.amount))}${mode==='requested'?`<small class="rr-ledger-note">Received ${esc(money(row.received))}<br>Unpaid ${esc(money(row.balance))}</small>`:''}</td></tr>`).join('') : '<tr><td colspan="9" class="rr-empty">No records for this view in the selected dates.</td></tr>');
    const label=mode==='completed'?'Completed sales before refunds':mode==='payments'?'Money received after refunds':mode==='requested'?'Requested work value':'Net cash linked to missing work';
    put('revenueActivityTotal',line(`${label} · all ${rows.length} records`,total(rows),true)+(mode==='completed'?line('Minus refunds sent',-Number(r.refunds||0))+line('Completed sales after refunds',r.netSales,true):''));
    if(get('revenueActivityPage'))get('revenueActivityPage').textContent=`Showing ${rows.length?(page-1)*size+1:0}–${Math.min(page*size,rows.length)} of ${rows.length}`;
    if(get('revenueActivityPrevious'))get('revenueActivityPrevious').disabled=page<=1;
    if(get('revenueActivityNext'))get('revenueActivityNext').disabled=page*size>=rows.length;
  }
  function renderCostRecords() {
    const details=report.costDetails, list=get('revenueCostRecordList');
    if(!list || !details)return;
    const select=get('revenueCostCategory'),selected=select?.value||'all';
    const groups=details.categories.filter(group=>selected==='all'||group.key===selected);
    const rows=groups.flatMap(group=>(group.records||[]).map(row=>({...row,category:group.label})))
      .sort((a,b)=>(new Date(b.date).getTime()||0)-(new Date(a.date).getTime()||0));
    const costTotal=groups.reduce((sum,group)=>sum+Number(group.total||0),0),count=groups.reduce((sum,group)=>sum+Number(group.recordCount||0),0);
    costPage=Math.min(Math.max(1,costPage),Math.max(1,Math.ceil(rows.length/size)));
    if(get('revenueCostRecordTotal'))get('revenueCostRecordTotal').textContent=money(costTotal);
    if(get('revenueCostRecordCount'))get('revenueCostRecordCount').textContent=`${count.toLocaleString('en-PH')} cost ${count===1?'entry':'entries'} in the selected dates`;
    const warnings=[];
    if(groups.some(group=>group.restricted))warnings.push('Payroll totals are included above. Only administrators can view individual payroll records.');
    if(groups.some(group=>group.truncated))warnings.push(`The list is limited to ${details.maxRecordsPerCategory} entries per source. Select a smaller date range to inspect the remaining records. Totals still include all costs.`);
    if(groups.some(group=>group.reconciled===false))warnings.push('Some saved cost totals do not match their available details. Review the original records; the report total has not been changed.');
    const warning=get('revenueCostRecordWarning');
    if(warning){warning.textContent=warnings.join(' ');warning.hidden=!warnings.length;}
    list.innerHTML=rows.length?rows.slice((costPage-1)*size,costPage*size).map(row=>{
      const quantity=row.quantity==null?'':`${Number(row.quantity).toLocaleString('en-PH')} ${esc(row.unit||'units')}${row.unitCost==null?'':` × ${esc(money(row.unitCost))}`}`;
      const components=row.components||[];
      const componentHtml=components.length?`<details class="rr-cost-components"${row.kind==='pos'?' open':''}><summary>${row.kind==='payroll'?'Pay components':'Saved items'}</summary>${components.map(item=>row.kind==='pos'&&Object.hasOwn(item,'sellingPrice')?`<section class="rr-cost-product"><h5>${esc(item.label)}</h5>${productPrices(item)}</section>`:`<div><span>${esc(item.label)}${item.quantity==null?'':` <small>${Number(item.quantity).toLocaleString('en-PH')} × ${esc(money(item.unitCost))}</small>`}</span><strong>${esc(money(item.amount))}</strong></div>`).join('')}<div class="rr-cost-component-total"><span>Listed components</span><strong>${esc(money(total(components)))}</strong></div>${row.kind==='pos'?'<p class="rr-price-note">Prices recorded at sale. Item gross profit is before bill discounts.</p>':''}</details>`:'';
      const salePricing=row.salePricing?`<section class="rr-sale-pricing"><h5>Sale summary</h5>${priceMetrics([['Sale total after discount',savedMoney(row.salePricing.salesAmount)],...(row.salePricing.discount>0?[['Bill discount',savedMoney(row.salePricing.discount)]]:[]),['Product cost deducted',savedMoney(row.amount)],['Sale gross profit',savedMoney(row.salePricing.grossProfit)]])}<p class="rr-price-note">Sale gross profit is before operating expenses, payroll and period refunds.</p></section>`:'';
      const orderPricing=Object.hasOwn(row,'sellingPrice')?`<section class="rr-cost-product">${productPrices(row)}<p class="rr-price-note">Item gross profit is before order-level discounts, delivery, installation and other costs.</p></section>`:'';
      return `<article class="rr-cost-record"><div class="rr-cost-record-copy"><div class="rr-cost-record-tags"><span>${esc(row.category)}</span><span>${esc(title(row.status))}</span></div><h4>${esc(row.title)}</h4>${row.description?`<p>${esc(row.description)}</p>`:''}<p class="rr-cost-record-reference">${esc(date(row.date))} · ${esc(row.reference)}</p>${row.periodStart||row.periodEnd?`<p>Pay period: ${esc(date(row.periodStart))} – ${esc(date(row.periodEnd))}</p>`:''}<small>${esc(row.basis)}</small>${orderPricing}${componentHtml}${salePricing}${row.warning?`<p class="rr-ledger-warning">${esc(row.warning)}</p>`:''}</div><div class="rr-cost-record-amount"><small>${row.kind==='pos'||orderPricing?'Product cost deducted':'Amount counted'}</small><strong>${esc(money(row.amount))}</strong>${quantity?`<span>${quantity}</span>`:''}</div></article>`;
    }).join(''):`<p class="rr-empty">${groups.some(group=>group.restricted&&Number(group.total))?'Payroll cost is included in the total. Sign in as an administrator to inspect its records.':'No cost entries are included for this source in the selected dates.'}</p>`;
    if(get('revenueCostRecordPage'))get('revenueCostRecordPage').textContent=`Showing ${rows.length?(costPage-1)*size+1:0}–${Math.min(costPage*size,rows.length)} of ${rows.length} listed entries`;
    if(get('revenueCostPrevious'))get('revenueCostPrevious').disabled=costPage<=1;
    if(get('revenueCostNext'))get('revenueCostNext').disabled=costPage*size>=rows.length;
  }
  function updateCostCategories() {
    const select=get('revenueCostCategory'),details=report.costDetails;
    if(select&&details){
      const selected=select.value||'all';
      select.innerHTML='<option value="all">All cost sources</option>'+details.categories.map(group=>`<option value="${esc(group.key)}">${esc(group.label)} · ${esc(money(group.total))}</option>`).join('');
      select.value=selected==='all'||details.categories.some(group=>group.key===selected)?selected:'all';
    }
    renderCostRecords();
  }
  function render(A) {
    report=A||{};page=1;costPage=1;
    const consistency = get('revenueConsistency');
    if (consistency) {
      const failed = A.consistency && !A.consistency.matches;
      consistency.className = failed ? 'alert alert-danger small' : 'd-none';
      consistency.textContent = failed ? 'Some report breakdowns do not reconcile. Refresh the report and ask an administrator to run the read-only data audit before using these totals.' : '';
    }
    updateCostCategories();
    if(A.recognizedRevenue!==undefined || A.reconciliation?.netSales!==undefined) {
      const costs=A.reconciliation||{},direct=Number(costs.savedDirectCosts??A.totalPartsCost??0),expenses=Number(costs.approvedExpenses??A.approvedExpenseTotal??0),payroll=Number(costs.payroll??A.payrollCost??0);
      const detailed=[['Less saved service job costs',A.serviceDirectCost],['Less saved order costs',A.orderCost],['Less walk-in / POS product costs',A.posCost],['Less project materials',A.projectMaterialCost]];
      const splitAvailable=detailed.every(([,value])=>value!==undefined);
      put('profitReconciliation',`<h3>How this profit was calculated</h3><p>Costs use the selected dates. Approved expenses and approved or paid payroll can remain even when there are no completed bookings or orders.</p><div class="rr-reconcile-lines">${line('Completed sales after refunds',costs.netSales??A.recognizedRevenue)}${splitAvailable?detailed.map(([label,value])=>line(label,-Number(value||0))).join(''):line('Less saved job and product costs',-direct)}${line('Less approved operating expenses',-expenses)}${line('Less approved and paid payroll',-payroll)}${line('Total costs deducted',direct+expenses+payroll,true)}${line('Profit after expenses',costs.operatingProfit??A.operatingProfit,true)}</div>`);
    }
    const r=A.reconciliation;if(!r)return;
    put('revenueBasis',`<strong>What these totals mean</strong><p>Completed sales covers finished services, fulfilled orders and counter sales. Money received covers customer payments minus refunds sent. It includes payments for unfinished work. Unpaid balance shows what customers still owe for work requested in the selected dates.</p><span>${esc(date(A.reportPeriod?.startDate))} – ${esc(date(A.reportPeriod?.endDate))} · Philippine time</span>`);
    put('salesReconciliation',line('Services completed',A.salesView?.serviceRevenue)+line('Orders completed, including fees',A.salesView?.orderRevenue)+line('Counter sales completed',A.salesView?.posRevenue)+line('Sales before refunds',r.grossSales,true)+line('Minus refunds sent',-r.refunds)+line('Completed sales after refunds',r.netSales,true));
    put('cashReconciliation',`<h3>Customer payments and refunds</h3><p>Includes deposits, full payments and money still held by technicians. Some payments are for unfinished work. Refunds sent can include older bookings and orders. All amounts below use the selected dates.</p><div class="rr-reconcile-lines">${r.cashBreakdown.filter(row=>row.collections||row.refunds).map(row=>line(row.label,row.collections)).join('')}${line('Customer payments before refunds',r.grossCollections,true)}${line('Minus refunds sent',-r.refunds)}${line('Money received after refunds',r.netCollections,true)}</div>${r.unmatchedPaymentRecords?`<p class="rr-ledger-warning">${r.unmatchedPaymentRecords} payment records refer to missing work. ${esc(money(r.unmatchedCollections))} of collections needs review. Open Activity → Unmatched payments to inspect these records.</p>`:''}`);
    put('requestedReconciliation',`<h3>Payment coverage of requested work</h3><p>This balance follows the work requested in these dates. It is separate from cash received during the period. Each payment is applied only to its own booking or order.</p><div class="rr-reconcile-lines">${line('Requested work value',r.requestedValue)}${line('Payments applied to this work, up to the end date',r.appliedPayments)}${line('Unpaid balance on this work',r.unpaidBalance,true)}</div><p>${Number(r.paidCoveragePercent||0).toFixed(1)}% paid. Refunds do not reopen a settled charge.${r.paidStatusMismatchCount?` ${r.paidStatusMismatchCount} paid labels need checking against the payment ledger.`:''}</p>`);
    put('serviceReconciliation',line('Completed service sales before refunds',r.serviceGrossSales)+line('Less refunds on these completed services',-r.serviceRefundsOnCompletedWork)+line('Service sales used in the profit tables',r.serviceNetSales,true)+line('Saved service and project costs',r.serviceCosts)+`<p>Includes completed services only. Refunds of work completed outside these dates appear in Collections and in the overall period refund adjustment.</p>`);
    put('productReconciliation',line('Completed order items',r.orderItemSales)+line('Order fees and price adjustments',r.orderFeesAndAdjustments)+line('Completed order total',A.salesView?.orderRevenue,true)+line('Completed counter items',r.counterItemSales)+line('Other counter amounts and adjustments',r.counterFeesAndAdjustments)+line('Completed counter total',A.salesView?.posRevenue,true)+`<p>Product rankings show item sales. Delivery, installation and other adjustments are listed above. Period refunds appear in the Sales and Collections reconciliation.</p>`);
    renderActivity();
  }
  document.addEventListener('change',event=>{if(event.target.id==='revenueActivityView'){page=1;renderActivity();}if(event.target.id==='revenueCostCategory'){costPage=1;renderCostRecords();}});
  document.addEventListener('click',event=>{if(event.target.closest('#revenueActivityPrevious')){page--;renderActivity();}if(event.target.closest('#revenueActivityNext')){page++;renderActivity();}if(event.target.closest('#revenueCostPrevious')){costPage--;renderCostRecords();}if(event.target.closest('#revenueCostNext')){costPage++;renderCostRecords();}});
  window.RACSRevenueReconciliation={render,serviceCost:row=>Number(row.partsCost||0)+Number(row.consumablesCost||0)+Number(row.laborCost||0)+Number(row.localPurchaseCost||0),salesView:A=>A.salesView||A,monthKey:value=>new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,7)};
})();
