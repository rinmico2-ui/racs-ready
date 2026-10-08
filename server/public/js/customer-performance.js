(function () {
  'use strict';
  const root = document.querySelector('[data-customer-performance]');
  if (!root) return;
  const profileId = root.dataset.customerId;
  const get = id => document.getElementById(id);
  const periodForm = get('cpPeriodForm'), state = get('cpState'), retry = get('cpRetry');
  const money = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const number = new Intl.NumberFormat('en-PH');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const formatMoney = value => money.format(Number(value) || 0);
  const count = value => number.format(Number(value) || 0);
  const formatDate = value => {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric' });
  };
  const params = () => new URLSearchParams(window.location.search);
  const reportKeys = ['range', 'from', 'to', 'inactiveDays', 'list', 'search', 'segment', 'sort', 'page'];
  const reportQuery = () => { const input = params(), selected = new URLSearchParams(); reportKeys.forEach(key => { if (input.has(key)) selected.set(key, input.get(key)); }); return selected; };
  const profileHref = id => '/admin/reports/customers/' + encodeURIComponent(id) + '?' + reportQuery();
  const badge = label => {
    const tone = /Inactive|Very Low|Low Engagement|Never Engaged|cancelled|no-show|refunded|Blocked/i.test(label) ? 'warn' : /^(Active|completed|repair_completed|closed)$/i.test(label) ? 'good' : 'muted';
    return `<span class="cp-badge ${tone}">${escape(String(label || 'Unknown').replace(/_/g, ' '))}</span>`;
  };
  const facts = rows => rows.map(([label, value, featured]) => `<div${featured ? ' class="cp-summary-total"' : ''}><dt>${escape(label)}</dt><dd>${value}</dd></div>`).join('');
  const empty = text => `<p class="cp-empty">${escape(text)}</p>`;
  let controller, lastData;

  function hydrateForm(form, keys) {
    const query = params();
    keys.forEach(key => { const element = form.elements.namedItem(key); if (element && query.has(key)) element.value = query.get(key); });
  }
  function setUrl(changes) {
    const url = new URL(window.location.href);
    Object.entries(changes).forEach(([key, value]) => { if (value === null || value === '') url.searchParams.delete(key); else url.searchParams.set(key, value); });
    window.history.replaceState(null, '', url);
  }
  function applyForm(form, keys, resetKeys) {
    const values = new FormData(form), changes = {};
    keys.forEach(key => { changes[key] = values.get(key) || null; });
    (resetKeys || []).forEach(key => { changes[key] = null; });
    if (form === periodForm && changes.range !== 'custom') changes.from = changes.to = null;
    setUrl(changes);
  }
  function updatePagination() {
    const update = (kind, list) => {
      if (!list) return;
      get(`cp${kind}Previous`).disabled = Boolean(controller) || list.page <= 1;
      get(`cp${kind}Next`).disabled = Boolean(controller) || list.page * list.pageSize >= list.total;
    };
    if (profileId) { update('Booking', lastData?.bookings); update('Order', lastData?.orders); }
    else update('', lastData?.customers);
  }
  async function load() {
    if (controller) controller.abort();
    const current = new AbortController(); controller = current;
    state.hidden = false; state.className = 'cp-state'; state.textContent = 'Loading customer report…'; retry.hidden = true;
    root.setAttribute('aria-busy', 'true'); updatePagination();
    try {
      const endpoint = '/api/admin/reports/customers' + (profileId ? '/' + encodeURIComponent(profileId) : '');
      const response = await fetch(endpoint + window.location.search, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: current.signal });
      const data = await response.json();
      if (controller !== current) return;
      if (!response.ok) throw new Error(data.error || 'Customer report unavailable.');
      lastData = data;
      const rangeLabels = { all: 'All time', month: 'This month', '3months': 'Last 3 months', '6months': 'Last 6 months', year: 'This year', custom: 'Custom period' };
      const dates = data.period.range === 'all' ? `Through ${formatDate(data.period.to)}` : `${formatDate(data.period.from)} – ${formatDate(data.period.to)}`;
      const updated = new Date(data.asOf).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
      get('cpPeriodLabel').textContent = `${rangeLabels[data.period.range]} · ${dates} · ${data.period.inactiveDays}-day inactivity window · Updated ${updated}`;
      periodForm.elements.range.value = data.period.range;
      periodForm.elements.inactiveDays.value = String(data.period.inactiveDays);
      periodForm.classList.toggle('is-custom', data.period.range === 'custom');
      if (profileId) renderProfile(data); else renderOverview(data);
      state.hidden = true;
    } catch (error) {
      if (error.name !== 'AbortError' && controller === current) {
        state.className = 'cp-state error';
        state.textContent = (error.message || 'Customer report unavailable.') + (lastData ? ' The previously loaded report remains below.' : '');
        retry.hidden = false;
      }
    } finally {
      if (controller === current) { controller = null; root.setAttribute('aria-busy', 'false'); updatePagination(); }
    }
  }

  function renderOverview(data) {
    setUrl({ list: data.customers.list, page: data.customers.page });
    const filters = get('cpTableFilters');
    if (data.customers.filters) Object.entries(data.customers.filters).forEach(([key, value]) => { if (filters.elements.namedItem(key)) filters.elements.namedItem(key).value = value; });
    const summary = data.summary, { booker, buyer } = data.leaders;
    const metrics = [
      ['Frequent customers', count(summary.frequentCustomers), '5+ successful transactions in period', ''],
      ['Most frequent booker', booker ? `<a href="${profileHref(booker.id)}">${escape(booker.name)}</a>` : 'None yet', booker ? `${count(booker.completedBookings)} completed bookings in period` : 'No successful bookings in period', ''],
      ['Most frequent buyer', buyer ? `<a href="${profileHref(buyer.id)}">${escape(buyer.name)}</a>` : 'None yet', buyer ? `${count(buyer.completedOrders)} completed orders in period` : 'No successful orders in period', ''],
      ['Never engaged', count(summary.neverEngaged), 'No successful bookings or orders, lifetime', 'alert'],
      ['Previously active, now inactive', count(summary.inactive), `5+ lifetime transactions; none in ${data.period.inactiveDays} days`, 'alert'],
    ];
    get('cpMetrics').innerHTML = metrics.map(([label, value, note, tone]) => `<article class="cp-kpi ${tone}"><span>${escape(label)}</span><strong>${value}</strong><small>${escape(note)}</small></article>`).join('');
    const list = data.customers.list, low = list === 'lowest', allTime = data.period.range === 'all';
    const titles = { frequent: 'Frequent Customers', records: 'Customer Records', lowest: 'Lowest Customer Engagement' };
    const descriptions = { frequent: 'Customers with successful completions in this period. Sort bookings and orders separately to see different customer habits.', records: `Search all ${count(summary.totalCustomers)} customer accounts. Open View for actual transactions, services, products, spending, and loyalty.`, lowest: `Lifetime totals. Review customers with fewer than 5 transactions or no completion within ${data.period.inactiveDays} days.` };
    get('cpTableTitle').textContent = titles[list]; get('cpTableDescription').textContent = descriptions[list];
    root.querySelectorAll('[data-cp-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cpView === list)));
    get('cpTableCaption').textContent = titles[list] + (low ? ' using lifetime activity' : ' for the selected analysis period');
    const columns = low ? ['Customer', 'Bookings', 'Orders', 'Total', 'Last activity', 'Days since', 'Engagement status', 'Action'] : ['Customer', 'Bookings', 'Orders', 'Total transactions', 'Total spending', 'Last activity', 'Action'];
    get('cpCustomerHead').innerHTML = '<tr>' + columns.map((column, i) => `<th scope="col"${i > 0 && i < (low ? 4 : 5) ? ' class="cp-numeric"' : ''}>${column}</th>`).join('') + '</tr>';
    const qty = (periodValue, lifetimeValue) => `<td class="cp-numeric">${count(low ? lifetimeValue : periodValue)}${allTime ? '' : `<small>${count(low ? periodValue : lifetimeValue)} ${low ? 'in period' : 'lifetime'}</small>`}</td>`;
    get('cpCustomerRows').innerHTML = data.customers.rows.length ? data.customers.rows.map(row => {
      const name = `<td><strong>${escape(row.name)}</strong><small>${escape(row.email)}</small>${row.newAccount ? '<small>New account in review window</small>' : ''}</td>`;
      const counts = qty(row.completedBookings, row.lifetimeBookings) + qty(row.completedOrders, row.lifetimeOrders) + qty(row.completedTransactions, row.lifetimeTransactions);
      const view = `<td><a class="cp-view-link" href="${profileHref(row.id)}" aria-label="View records for ${escape(row.name)}">View <i class="bi bi-arrow-up-right" aria-hidden="true"></i></a></td>`;
      if (low) return `<tr>${name}${counts}<td>${row.lifetimeTransactions ? formatDate(row.lastActivity) : 'Never'}</td><td class="cp-numeric">${row.daysSinceLastActivity === null ? '—' : count(row.daysSinceLastActivity)}</td><td>${badge(row.engagement)}</td>${view}</tr>`;
      const last = row.completedTransactions ? formatDate(row.periodLastActivity) : 'No period activity';
      return `<tr>${name}${counts}<td class="cp-numeric">${formatMoney(row.recordedSpending)}${allTime ? '' : `<small>${formatMoney(row.lifetimeSpending)} lifetime</small>`}</td><td>${last}${allTime ? '' : `<small>Lifetime: ${row.lifetimeTransactions ? formatDate(row.lastActivity) : 'Never'}</small>`}</td>${view}</tr>`;
    }).join('') : `<tr><td colspan="${columns.length}" class="cp-empty">No customers match these filters. Try Customer Records or clear the activity filter.</td></tr>`;
    const { total, page, pageSize } = data.customers;
    get('cpTableCount').textContent = total ? `Showing ${count((page - 1) * pageSize + 1)}–${count(Math.min(page * pageSize, total))} of ${count(total)} customers · Page ${page} of ${Math.ceil(total / pageSize)}` : 'No matching customers';
    get('cpMethod').textContent = data.methodology;
  }

  function renderProfile(data) {
    const customer = data.customer;
    get('cpBack').href = '/admin/reports/customers?' + reportQuery();
    get('cpPageTitle').textContent = 'Customer Records'; get('cpProfileTitle').textContent = customer.name;
    get('cpProfileMeta').textContent = `${customer.email} · Joined ${formatDate(customer.createdAt)}${customer.daysSinceLastActivity === null ? '' : ` · Last completed activity ${count(customer.daysSinceLastActivity)} days ago`}`;
    get('cpProfileStatus').innerHTML = `${badge(customer.accountStatus)} ${badge(customer.engagement)}${customer.newAccount ? ' ' + badge('New account') : ''}`;
    const summary = lifetime => facts([
      ['Completed bookings', count(lifetime ? customer.lifetimeBookings : customer.completedBookings)],
      ['Completed orders', count(lifetime ? customer.lifetimeOrders : customer.completedOrders)],
      ['Total transactions', count(lifetime ? customer.lifetimeTransactions : customer.completedTransactions)],
      ['Recorded spending', formatMoney(lifetime ? customer.lifetimeSpending : customer.recordedSpending), true],
      ['Last completed activity', escape(formatDate(lifetime ? customer.lastActivity : customer.periodLastActivity))],
    ]);
    get('cpSelectedSummary').innerHTML = summary(false); get('cpLifetimeSummary').innerHTML = summary(true);
    get('cpOtherStates').textContent = `Excluded from successful activity in this period: ${count(customer.cancelledBookings)} cancelled or declined bookings, ${count(customer.noShows)} no-shows, ${count(customer.cancelledOrders)} cancelled orders, ${count(customer.refundedBookings)} fully refunded bookings, and ${count(customer.refundedOrders)} fully refunded orders. Pending records do not count.`;
    get('cpServicePreferences').innerHTML = data.servicePreferences.length ? data.servicePreferences.map(item => `<div class="cp-preference-row"><span>${escape(item.name)}</span><strong>${count(item.bookings)} bookings</strong></div>`).join('') : empty('No successful completed service bookings in this period.');
    get('cpProductPreferences').innerHTML = data.productPreferences.length ? data.productPreferences.map(item => `<div class="cp-preference-row"><span>${escape(item.name)}<small>${count(item.orders)} orders</small></span><strong>${count(item.units)} units</strong></div>`).join('') : empty('No successful completed product orders in this period.');
    get('cpSpending').innerHTML = facts([
      ['Completed service value, after discounts', formatMoney(customer.serviceValue)],
      ['Completed order product value, after discounts', formatMoney(customer.productValue)],
      ['Order delivery and installation fees', formatMoney(customer.orderFees)],
      ['Completed order total (products + fees)', formatMoney(customer.orderValue)],
      ['Less completed transaction and item refunds', formatMoney(customer.refunds)],
      ['Net recorded spending (service + order − refunds)', formatMoney(customer.recordedSpending), true],
      ['Recorded discounts already included above', formatMoney(customer.discounts)],
    ]);
    get('cpCash').innerHTML = facts([['Gross accepted payments', formatMoney(data.collections.gross)], ['Payment refunds', formatMoney(data.collections.paymentRefunds)], ['Item refunds', formatMoney(data.collections.itemRefunds)], ['Net collections', formatMoney(data.collections.net), true]]);
    const loyalty = customer.loyalty;
    const scope = value => value === 'both' ? 'services and products' : value === 'orders' ? 'products' : 'services';
    get('cpLoyalty').innerHTML = !loyalty?.enabled ? '<p class="cp-note">Automatic loyalty discounts are currently disabled. <a href="/admin/customers/privileges">View loyalty rules</a>.</p>'
      : `${loyalty.tier ? `<p><strong>Current tier: ${escape(loyalty.tier)}</strong></p>` : '<p>No configured reward earned yet.</p>'}${(loyalty.qualifiedRules || []).map(rule => `<p class="cp-note">${escape(rule.name)}: <strong>${count(rule.discountPercent)}% discount</strong> on eligible ${scope(rule.appliesTo)} · ${count(rule.value)} / ${count(rule.target)} qualifying completions.</p>`).join('')}${loyalty.progress ? `<p class="cp-note">${escape(loyalty.progress.nextTier)}: <strong>${count(loyalty.progress.value)} / ${count(loyalty.progress.target)}</strong> qualifying lifetime completions. ${loyalty.progress.value >= loyalty.progress.target ? 'Requirement met.' : `${count(loyalty.progress.target - loyalty.progress.value)} more qualifying completions needed.`}</p>` : '<p class="cp-note">No active requirements configured.</p>'}<p class="cp-note">Qualification follows the configured booking, order, or service requirements. Checkout checks eligible items before applying a discount.</p>`;
    get('cpProfileNote').textContent = data.note;
    renderHistory(data);
  }

  function renderHistory(data) {
    get('cpBookingHistory').innerHTML = data.bookings.rows.length ? data.bookings.rows.map(row => `<article class="cp-history-record"><div class="cp-history-title"><strong><a href="/admin/appointments?tab=overview&amp;sel=${encodeURIComponent(row.id)}">Booking #${escape(row.reference)}</a></strong>${badge(row.status)}</div><p>${escape(row.services.map(item => [item.name, item.unit, item.hp ? item.hp + ' HP' : '', item.brand, item.model, item.quantity > 1 ? '×' + item.quantity : ''].filter(Boolean).join(' · ')).join('; '))}</p><small>Requested ${formatDate(row.requestedDate)} · Scheduled ${formatDate(row.scheduledDate)} · Completed ${formatDate(row.completedDate)}</small><small>Amount ${formatMoney(row.amount)} · Discount ${formatMoney(row.discount)}${row.loyaltyDiscount ? ' · ' + escape(row.loyaltyDiscount.ruleName) : ''} · Payment ${escape(row.paymentStatus || 'unknown')} · Recorded refunds ${formatMoney(row.refundAmount)}${row.linkedOrder ? ' · Linked order installation; excluded from service totals' : ''}</small></article>`).join('') : empty('No bookings match these history filters.');
    get('cpOrderHistory').innerHTML = data.orders.rows.length ? data.orders.rows.map(row => `<article class="cp-history-record"><div class="cp-history-title"><strong><a href="/admin/appointments/orders?order=${encodeURIComponent(row.id)}">Order #${escape(row.reference)}</a></strong>${badge(row.status)}</div><p>${escape(row.items.map(item => `${item.name}${item.capacity ? ' · ' + item.capacity : ''} ×${item.quantity}`).join('; '))}</p><small>Ordered ${formatDate(row.date)} · Completed ${formatDate(row.completedDate)} · ${escape(String(row.fulfillmentType || 'Fulfillment not recorded').replace(/_/g, ' '))}</small><small>Subtotal ${formatMoney(row.subtotal)} · Discount ${formatMoney(row.discount)} · Order total ${formatMoney(row.total)} · Payment ${escape(row.paymentStatus || 'unknown')} · Recorded refunds ${formatMoney(row.refundAmount)}</small></article>`).join('') : empty('No orders match these history filters.');
    [['Booking', data.bookings], ['Order', data.orders]].forEach(([kind, list]) => { get(`cp${kind}Count`).textContent = `${count(list.total)} matching records · Page ${list.page} of ${Math.max(1, Math.ceil(list.total / list.pageSize))}`; });
  }

  hydrateForm(periodForm, ['range', 'from', 'to', 'inactiveDays']);
  if (!periodForm.elements.range.value) periodForm.elements.range.value = 'all';
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  ['cpFrom', 'cpTo'].forEach(id => { get(id).max = today; });
  function toggleCustom() {
    const custom = periodForm.elements.range.value === 'custom'; periodForm.classList.toggle('is-custom', custom);
    periodForm.elements.from.required = periodForm.elements.to.required = custom;
  }
  toggleCustom(); periodForm.elements.range.addEventListener('change', toggleCustom);
  periodForm.addEventListener('submit', event => { event.preventDefault(); applyForm(periodForm, ['range', 'from', 'to', 'inactiveDays'], ['page', 'bookingPage', 'orderPage']); load(); });
  retry.addEventListener('click', load);
  if (!profileId) {
    const filters = get('cpTableFilters'); hydrateForm(filters, ['search', 'segment', 'sort']);
    if (!params().has('sort') && params().get('list') === 'lowest') filters.elements.sort.value = 'least';
    filters.addEventListener('submit', event => { event.preventDefault(); applyForm(filters, ['search', 'segment', 'sort'], ['page']); load(); });
    root.querySelectorAll('[data-cp-view]').forEach(button => button.addEventListener('click', () => { const list = button.dataset.cpView; filters.elements.segment.value = 'all'; filters.elements.sort.value = list === 'lowest' ? 'least' : 'transactions'; setUrl({ list, segment: null, sort: filters.elements.sort.value, page: null }); load(); }));
    get('cpClearFilters').addEventListener('click', () => { filters.reset(); filters.elements.sort.value = params().get('list') === 'lowest' ? 'least' : 'transactions'; applyForm(filters, ['search', 'segment', 'sort'], ['page']); load(); });
    [['cpPrevious', -1], ['cpNext', 1]].forEach(([id, offset]) => get(id).addEventListener('click', () => { if (!lastData || controller) return; setUrl({ page: lastData.customers.page + offset }); load(); }));
  } else {
    const filters = get('cpHistoryFilters'); hydrateForm(filters, ['bookingStatus', 'orderStatus', 'fromDate', 'toDate', 'historySort']);
    ['fromDate', 'toDate'].forEach(key => { filters.elements[key].max = today; });
    filters.addEventListener('submit', event => { event.preventDefault(); applyForm(filters, ['bookingStatus', 'orderStatus', 'fromDate', 'toDate', 'historySort'], ['bookingPage', 'orderPage']); load(); });
    get('cpClearHistory').addEventListener('click', () => { filters.reset(); applyForm(filters, ['bookingStatus', 'orderStatus', 'fromDate', 'toDate', 'historySort'], ['bookingPage', 'orderPage']); load(); });
    [['Booking', 'bookingPage'], ['Order', 'orderPage']].forEach(([kind, key]) => { [['Previous', -1], ['Next', 1]].forEach(([direction, offset]) => get(`cp${kind}${direction}`).addEventListener('click', () => { if (!lastData || controller) return; setUrl({ [key]: lastData[kind.toLowerCase() + 's'].page + offset }); load(); })); });
  }
  load();
})();
