(function () {
  'use strict';
  const root = document.getElementById('managementFocus');
  if (!root) return;
  const state = document.getElementById('managementFocusState');
  const health = document.getElementById('managementFocusHealth');
  const actionsHost = document.getElementById('managementFocusActions');
  const integer = new Intl.NumberFormat('en-PH');
  let loading = false;
  let loaded = false;

  function metric(label, value, detail) {
    const article = document.createElement('article');
    const small = document.createElement('small'); small.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = value;
    const span = document.createElement('span'); span.textContent = detail;
    article.append(small, strong, span);
    health.append(article);
  }

  function render(data) {
    health.replaceChildren();
    actionsHost.replaceChildren();
    metric('Most booked service', data.leaders.service?.name || 'No bookings recorded', data.leaders.service ? integer.format(data.leaders.service.bookings) + ' bookings in selected cohort' : 'Review service activity');
    metric('Best selling aircon', data.leaders.aircon?.name || 'No completed sales', data.leaders.aircon ? integer.format(data.leaders.aircon.units) + ' units sold' : 'Review product sales');
    metric('Most used service part', data.leaders.consumedPart?.name || 'No recorded use', data.leaders.consumedPart ? integer.format(data.leaders.consumedPart.consumed) + ' units used in completed services' : 'Review parts consumption');
    metric('Loyalty candidates', data.loyaltyPolicy ? integer.format(data.customers.qualifiedCount || 0) : 'Not configured', data.loyaltyPolicy ? 'Qualification preview' + (data.customers.customerCatalogCapped ? ' · customer cohort capped' : '') : 'Configure policy in Management Decisions');

    const priority = { 'Restock now': 0, 'Restock soon': 1, 'Hold purchasing': 2, 'Review margin': 3, 'Review pricing': 4, 'Review capacity': 5, 'Promote before restocking': 6, 'Consider promotion': 7 };
    const ranked = [...(data.actions || [])].sort((a, b) => (priority[a.action] ?? 20) - (priority[b.action] ?? 20));
    const selected = [...ranked.filter(item => item.kind !== 'service').slice(0, 4), ...ranked.filter(item => item.kind === 'service').slice(0, 2)]
      .sort((a, b) => (priority[a.action] ?? 20) - (priority[b.action] ?? 20)).slice(0, 6);
    if (!selected.length) {
      const empty = document.createElement('p'); empty.textContent = 'No specific management exception was supported by this month’s records. Review the detailed reports for trends.';
      actionsHost.append(empty);
    }
    selected.forEach(item => {
      const link = document.createElement('a');
      link.className = 'management-focus-action' + (item.action === 'Restock now' ? ' critical' : item.kind === 'service' ? ' review' : '');
      link.href = '/admin/reports?tab=decisions';
      const kind = document.createElement('small'); kind.textContent = item.kind || 'Business decision';
      const title = document.createElement('strong'); title.textContent = item.action + ': ' + item.name;
      const evidence = document.createElement('p'); evidence.textContent = item.evidence || 'Open the full report for details.';
      link.append(kind, title, evidence); actionsHost.append(link);
    });
    const asOf = data.asOf ? new Date(data.asOf).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    state.textContent = 'This month · updated ' + asOf + '. Suggestions are for management review; no stock or prices change here.';
  }

  async function load() {
    if (loading) return;
    loading = true;
    state.textContent = 'Loading management insights…';
    try {
      const response = await fetch('/api/admin/reports/decisions?range=month', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Management insights are unavailable.');
      render(data);
      loaded = true;
    } catch (error) {
      state.replaceChildren();
      const message = document.createElement('span'); message.textContent = error.message || 'Management insights are unavailable.';
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.className = 'btn btn-sm btn-outline-primary ms-2'; retry.addEventListener('click', load);
      state.append(message, retry);
    } finally { loading = false; }
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); if (!loaded) load(); }
    }, { rootMargin: '500px 0px' });
    observer.observe(root);
  } else load();
})();
