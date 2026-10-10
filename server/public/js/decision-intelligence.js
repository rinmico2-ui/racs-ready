(function () {
  'use strict';
  const form = document.getElementById('diFilters');
  if (!form) return;
  const reportRole = document.querySelector('[data-decision-role]')?.dataset.decisionRole === 'secretary' ? 'secretary' : 'admin';
  const state = document.getElementById('diState');
  const embedded = Boolean(document.querySelector('[data-report-center]'));
  const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 });
  const integer = new Intl.NumberFormat('en-PH');
  const manilaKey = value => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
    const part = type => parts.find(item => item.type === type)?.value || '';
    return part('year') + '-' + part('month') + '-' + part('day');
  };
  let payload = null;
  let requestController = null;
  let tab = 'aircon';
  let salesView = 'all';
  let customerView = 'top';
  let serviceView = 'all';
  let serviceLimit = 50;
  let productLimit = 50;

  function cell(row, value, small) {
    const td = document.createElement('td');
    if (small) {
      const strong = document.createElement('strong'); strong.textContent = value;
      const sub = document.createElement('small'); sub.textContent = small;
      td.append(strong, sub);
    } else td.textContent = value;
    row.append(td);
    return td;
  }
  function badge(row, value) {
    const td = cell(row, '');
    const span = document.createElement('span');
    span.className = 'di-badge' + (/Restock|Review|Low|No demand/.test(value) ? ' warn' : /High demand|Keep/.test(value) ? ' good' : '');
    span.textContent = value; td.append(span);
  }
  function table(id, rows, render, columns) {
    const host = document.getElementById(id); host.replaceChildren();
    if (!rows.length) { const tr = document.createElement('tr'); const td = cell(tr, 'No records in this period.'); td.colSpan = columns; host.append(tr); return; }
    rows.forEach(item => { const tr = document.createElement('tr'); render(tr, item); host.append(tr); });
  }
  function renderProducts() {
    if (!payload) return;
    const all = payload.products[tab] || [];
    const sold = all.filter(row => row.units > 0);
    const noSales = all.filter(row => row.units === 0);
    const low = [...sold].sort((a, b) => a.units - b.units || a.revenue - b.revenue).slice(0, Math.ceil(sold.length / 4));
    const ranked = salesView === 'top' ? [...sold].sort((a, b) => b.units - a.units || b.revenue - a.revenue)
      : salesView === 'low' ? [...low].sort((a, b) => a.units - b.units || a.revenue - b.revenue)
        : salesView === 'none' ? [...noSales].sort((a, b) => (a.lastRecordedSale ? 1 : 0) - (b.lastRecordedSale ? 1 : 0) || String(a.name).localeCompare(String(b.name))) : all;
    const query = document.getElementById('diProductSearch').value.trim().toLocaleLowerCase();
    const filtered = query ? ranked.filter(row => [row.name, row.brand, row.type, row.hp].some(value => String(value || '').toLocaleLowerCase().includes(query))) : ranked;
    const rows = filtered.slice(0, productLimit);
    document.getElementById('diProductMore').hidden = rows.length >= filtered.length;
    document.getElementById('diProductSummary').textContent = `${all.length} catalog units · ${sold.length} sold · ${low.length} in the lowest sold quartile · ${noSales.length} without sales in this period. Showing ${rows.length} of ${filtered.length} matching units. ${salesView === 'none' ? 'No sales includes items that may have sold before this period. Check the last recorded sale before changing stock plans.' : 'Compare stock and service use before changing purchasing.'}`;
    table('diProducts', rows, (tr, r) => {
      const productCell = cell(tr, r.name, [r.brand, r.type, r.hp ? String(r.hp) + ' HP' : ''].filter(Boolean).join(' · '));
      const productLink = document.createElement('a'); productLink.textContent = r.name;
      productLink.href = r.source === 'order' ? '/' + reportRole + '/reports/orders?range=custom&from=' + manilaKey(payload.period.from) + '&to=' + manilaKey(payload.period.to) + '&q=' + encodeURIComponent(r.name) : r.source === 'mixed' ? '/' + reportRole + '/reports/inventory' : (reportRole === 'secretary' ? '/secretary/pointofsale' : '/admin/inventory/pos');
      productLink.title = r.source === 'order' ? 'Inspect matching order records' : r.source === 'mixed' ? 'Inspect inventory and movement records' : 'Open counter sales records';
      productCell.firstChild.replaceWith(productLink);
      badge(tr, r.demand);
      cell(tr, integer.format(r.units), r.salesDemand + ' · ' + r.salesPer30Days + '/30 days');
      cell(tr, r.consumed ? integer.format(r.consumed) : '—', r.consumptionDemand + (r.consumed ? ' · ' + r.consumptionPer30Days + '/30 days · ' + r.completedServices + ' completed services' : ''));
      cell(tr, peso.format(r.revenue));
      cell(tr, r.contribution === null ? 'Some costs are missing' : peso.format(r.contribution), r.margin === null ? '' : r.margin + '% estimated profit');
      cell(tr, r.stock === null ? 'Unknown' : integer.format(r.stock), r.stockCoverDays === null ? (r.lowStock ? 'At or below reorder level' : 'No observed run rate') : r.stockCoverDays + ' days of stock left' + (r.lowStock ? ' · at/below reorder level' : ''));
      cell(tr, r.lastRecordedSale ? new Date(r.lastRecordedSale).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }) : 'No recorded sale', r.lastRecordedSale ? (r.daysSinceLastSale === 0 ? 'Today' : `${r.daysSinceLastSale} days ago`) : 'Check catalog age and service use');
      badge(tr, r.action);
    }, 9);
  }
  function renderLoyalty(data) {
    const host = document.getElementById('diLoyaltySummary'); host.replaceChildren();
    if (!data.loyaltyPolicy?.enabled) { const item = document.createElement('div'); item.className = 'di-segment'; item.textContent = 'Automatic loyalty discounts are disabled. Admins can set rules in Customer Privileges.'; host.append(item); }
    else [['Qualified', data.customers.qualifiedCount], ['Approaching a reward', data.customers.approachingCount]].forEach(([name, count]) => {
      const item = document.createElement('div'); item.className = 'di-segment'; item.textContent = name + ' ';
      const strong = document.createElement('strong'); strong.textContent = integer.format(count); item.append(strong); host.append(item);
    });
    table('diLoyalty', [...data.customers.qualified, ...data.customers.approaching], (tr, r) => {
      cell(tr, r.name); badge(tr, r.loyalty.tier || 'Approaching');
      cell(tr, integer.format(r.loyalty.progress.value) + ' / ' + integer.format(r.loyalty.progress.target), 'Lifetime completions · ' + r.loyalty.progress.percent + '%');
      cell(tr, r.loyalty.progress.nextTier || 'Qualified');
    }, 4);
  }
  function renderServices() {
    if (!payload) return;
    const all = payload.services;
    const booked = all.filter(row => row.bookings > 0);
    const lowest = [...booked].sort((a, b) => a.bookings - b.bookings || a.completedValue - b.completedValue).slice(0, Math.ceil(booked.length / 4));
    const unrequested = all.filter(row => row.bookings === 0);
    const ranked = serviceView === 'top' ? [...booked].sort((a, b) => b.bookings - a.bookings)
      : serviceView === 'low' ? lowest : serviceView === 'none' ? unrequested : all;
    const rows = ranked.slice(0, serviceLimit);
    document.getElementById('diServiceMore').hidden = rows.length >= ranked.length;
    document.getElementById('diServiceSummary').textContent = `${all.length} service and unit combinations · ${booked.length} requested · ${lowest.length} in the lowest requested quartile · ${unrequested.length} with no requests in this period. Showing ${rows.length} of ${ranked.length}; requests are counted when bookings were created.`;
    table('diServices', rows, (tr, r) => {
      const serviceCell = cell(tr, r.name, [r.category, r.unit, r.hp ? r.hp + ' HP' : ''].filter(Boolean).join(' · '));
      const serviceLink = document.createElement('a'); serviceLink.textContent = r.name;
      serviceLink.href = '/' + reportRole + '/reports/service?range=custom&from=' + manilaKey(payload.period.from) + '&to=' + manilaKey(payload.period.to) + '&service=' + encodeURIComponent(r.name);
      serviceLink.title = 'Inspect matching service records'; serviceCell.firstChild.replaceWith(serviceLink);
      badge(tr, r.demand); cell(tr, integer.format(r.bookings), r.frequencyPer30Days + '/30 days · ' + r.recentBookings + ' in recent half');
      cell(tr, integer.format(r.completed)); cell(tr, integer.format(r.cancelled)); cell(tr, peso.format(r.completedValue), r.completed ? peso.format(r.averageCompletedValue) + ' average' : '');
      badge(tr, r.demand === 'High demand' ? 'Check technician availability' : r.demand === 'Low demand' ? 'Consider a special offer' : r.bookings === 0 ? 'Check if customers can find it' : 'Monitor');
    }, 7);
  }
  function renderCustomers() {
    if (!payload) return;
    const customers = payload.customers;
    const rows = customers[customerView] || [];
    document.getElementById('diCustomerSummary').textContent = `${customers.totalCustomers} customer accounts · ${customers.followUpTotal || 0} eligible for follow-up · ${customers.crossServiceTotal || 0} with sales or service only. Each list shows up to 30 accounts.`;
    table('diCustomers', rows, (tr, r) => {
      const nameCell = cell(tr, r.name);
      if (reportRole === 'admin' && r.id) {
        const link = document.createElement('a');
        link.href = '/admin/reports/customers/' + encodeURIComponent(r.id);
        link.textContent = r.name;
        nameCell.firstChild.replaceWith(link);
      }
      badge(tr, r.segment);
      cell(tr, r.score + '/9', r.scoreBreakdown.recency + ' recency · ' + r.scoreBreakdown.frequency + ' frequency · ' + r.scoreBreakdown.monetary + ' value');
      cell(tr, integer.format(r.completedBookings), r.neverBooked ? 'Never booked' : `${integer.format(r.lifetimeBookings)} all-time`);
      cell(tr, integer.format(r.completedOrders), r.neverPurchased ? 'Never purchased' : `${integer.format(r.lifetimeOrders)} all-time`);
      cell(tr, peso.format(r.spend));
      cell(tr, r.lifetimeLastActivity ? new Date(r.lifetimeLastActivity).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }) : 'No completed activity', r.inactivityDays === null ? '' : `${r.inactivityDays} days ago`);
      cell(tr, r.suggestedAction || 'Review customer record');
    }, 8);
  }
  function render(data) {
    payload = data; state.textContent = '';
    const displayDate = value => new Date(value).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric' });
    document.getElementById('diPeriod').textContent = displayDate(data.period.from) + ' – ' + displayDate(data.period.to);
    const answers = [
      ['Most booked service', data.leaders.service?.name || 'No data', data.leaders.service ? data.leaders.service.bookings + ' bookings · ' + data.leaders.service.unit : ''],
      ['Best-selling aircon', data.leaders.aircon?.name || 'No data', data.leaders.aircon ? data.leaders.aircon.units + ' units sold' : ''],
      ['Top tool', data.leaders.tool?.name || 'No data', data.leaders.tool ? data.leaders.tool.units + ' sold' : ''],
      ['Top repair part sold', data.leaders.part?.name || 'No data', data.leaders.part ? data.leaders.part.units + ' sold' : ''],
      ['Most used service part', data.leaders.consumedPart?.name || 'No data', data.leaders.consumedPart ? data.leaders.consumedPart.consumed + ' used in completed services' : ''],
      ['Item with the highest estimated profit', data.leaders.contribution?.name || 'Some costs are missing', data.leaders.contribution ? peso.format(data.leaders.contribution.contribution) + ' before item refunds' : ''],
      ['Most active customer', data.leaders.customer?.name || 'No data', data.leaders.customer ? (data.leaders.customer.completedBookings + data.leaders.customer.completedOrders) + ' completed transactions' : ''],
    ];
    const answerHost = document.getElementById('diAnswers'); answerHost.replaceChildren();
    answers.forEach(([label, value, detail]) => {
      const article = document.createElement('article'); article.className = 'di-answer';
      const small = document.createElement('small'); small.textContent = label;
      const strong = document.createElement('strong'); strong.textContent = value;
      const span = document.createElement('span'); span.textContent = detail;
      article.append(small, strong, span); answerHost.append(article);
    });
    const actions = document.getElementById('diActions'); actions.replaceChildren();
    (data.actions.length ? data.actions : [{ kind: 'Review', name: 'No immediate product exception', action: 'Monitor', evidence: 'Continue reviewing service and customer trends.' }]).forEach(item => {
      const article = document.createElement('article'); article.className = 'di-action';
      const title = document.createElement('strong'); title.textContent = item.action + ': ' + item.name;
      const p = document.createElement('p'); p.textContent = item.kind;
      const small = document.createElement('small'); small.textContent = item.evidence;
      article.append(title, p, small); actions.append(article);
    });
    renderServices();
    renderProducts();
    document.getElementById('diProductCaveat').textContent = data.products.caveat + ' Completed item refunds in these dates: ' + peso.format(data.products.refundTotal) + '.';
    const segments = document.getElementById('diSegments'); segments.replaceChildren();
    Object.entries(data.customers.segments).forEach(([name, count]) => {
      const item = document.createElement('div'); item.className = 'di-segment'; item.textContent = name + ' ';
      const strong = document.createElement('strong'); strong.textContent = integer.format(count); item.append(strong); segments.append(item);
    });
    renderCustomers();
    document.getElementById('diScoring').textContent = data.customers.scoring + (data.customers.customerCatalogCapped ? ' This list shows up to 10,000 accounts. Open Customer Records to see all accounts.' : '');
    document.getElementById('diMethod').textContent = data.methodology;
    renderLoyalty(data);
  }
  async function load() {
    if (requestController) requestController.abort();
    const controller = new AbortController();
    requestController = controller;
    state.textContent = 'Loading suggested actions…';
    try {
      const params = new URLSearchParams(new FormData(form));
      if (params.get('range') !== 'custom') { params.delete('from'); params.delete('to'); }
      const response = await fetch('/api/' + reportRole + '/reports/decisions?' + params.toString(), { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal });
      const data = await response.json();
      if (requestController !== controller) return;
      if (!response.ok) throw new Error(data.error || 'Report unavailable');
      render(data);
    } catch (error) {
      if (error.name !== 'AbortError' && requestController === controller) state.textContent = error.message || 'Report unavailable';
    } finally {
      if (requestController === controller) requestController = null;
    }
  }
  const initialParams = new URLSearchParams(window.location.search);
  if (['today', 'week', 'month', 'quarter', 'year', 'custom'].includes(initialParams.get('range'))) form.elements.range.value = initialParams.get('range');
  if (initialParams.get('from')) form.elements.from.value = initialParams.get('from');
  if (initialParams.get('to')) form.elements.to.value = initialParams.get('to');
  form.classList.toggle('is-custom', form.elements.range.value === 'custom');
  document.getElementById('diRange').addEventListener('change', () => form.classList.toggle('is-custom', form.elements.range.value === 'custom'));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const url = new URL(window.location.href);
    const filters = new URLSearchParams(new FormData(form));
    if (filters.get('range') !== 'custom') { filters.delete('from'); filters.delete('to'); }
    ['range', 'from', 'to'].forEach(key => url.searchParams.delete(key));
    filters.forEach((value, key) => url.searchParams.set(key, value));
    if (embedded) url.searchParams.set('tab', 'decisions');
    window.history.replaceState(window.history.state, '', url);
    load();
  });
  document.querySelectorAll('[data-di-tab]').forEach(button => button.addEventListener('click', () => {
    tab = button.dataset.diTab;
    productLimit = 50;
    document.querySelectorAll('[data-di-tab]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', item === button ? 'true' : 'false'); });
    renderProducts();
  }));
  document.querySelectorAll('[data-di-sales]').forEach(button => button.addEventListener('click', () => {
    salesView = button.dataset.diSales;
    productLimit = 50;
    document.querySelectorAll('[data-di-sales]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', item === button ? 'true' : 'false'); });
    renderProducts();
  }));
  document.getElementById('diProductSearch').addEventListener('input', () => { productLimit = 50; renderProducts(); });
  document.getElementById('diProductMore').addEventListener('click', () => { productLimit += 50; renderProducts(); });
  document.querySelectorAll('[data-di-customer]').forEach(button => button.addEventListener('click', () => {
    customerView = button.dataset.diCustomer;
    document.querySelectorAll('[data-di-customer]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', item === button ? 'true' : 'false'); });
    renderCustomers();
  }));
  document.querySelectorAll('[data-di-service]').forEach(button => button.addEventListener('click', () => {
    serviceView = button.dataset.diService;
    serviceLimit = 50;
    document.querySelectorAll('[data-di-service]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', item === button ? 'true' : 'false'); });
    renderServices();
  }));
  document.getElementById('diServiceMore').addEventListener('click', () => { serviceLimit += 50; renderServices(); });
  document.querySelectorAll('[data-di-tab],[data-di-sales],[data-di-customer],[data-di-service]').forEach(button => button.setAttribute('aria-pressed', button.classList.contains('active') ? 'true' : 'false'));
  document.addEventListener('reportcenter:decisions', () => { if (!payload) load(); });
  document.addEventListener('reportcenter:decisions-refresh', load);
  if (!embedded) load();
})();
