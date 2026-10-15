(function () {
  'use strict';
  var match = location.pathname.match(/^\/(admin|secretary)\/(reports(?:\/(revenue|orders|service|inventory|customers)(?:\/([a-f0-9]{24}))?)?|ratings\/(technicians))\/?$/);
  if (!match) return;
  var role = match[1], kind, profileId;
  // Groups are parsed explicitly so customer profile paths keep their scope.
  var parts = location.pathname.split('/').filter(Boolean);
  kind = parts[1] === 'ratings' ? 'technicians' : parts[2] || 'overview';
  profileId = parts[3] || '';
  function attach() {
    if (document.querySelector('[data-report-csv]')) return;
    var target = ['.rr-actions','.sr-filter-actions','.sr-filter-primary','.rc-hero-actions','.cp-hero','.au-hero-actions','.au-hero-inner','.report-nav'].map(function (selector) { return document.querySelector(selector); }).find(Boolean);
    if (!target) return;
    var button = document.createElement('button'); button.type = 'button'; button.dataset.reportCsv = kind;
    button.className = kind === 'revenue' ? 'rr-btn light' : ['orders','service'].includes(kind) ? 'sr-button' : kind === 'customers' ? 'cp-secondary' : 'btn btn-outline-primary';
    if (target.classList.contains('au-hero-inner')) target.style.flexWrap = 'wrap';
    button.innerHTML = '<i class="bi bi-filetype-csv me-1" aria-hidden="true"></i>Download CSV';
    target.appendChild(button);
  }
  function exportUrl() {
    var params = new URLSearchParams(location.search);
    var form = document.getElementById(kind === 'orders' ? 'orderReportFilter' : 'serviceReportFilters');
    if (form) new FormData(form).forEach(function (value, key) { if (typeof value === 'string') params.set(key, value); });
    if (kind === 'revenue') {
      params = new URLSearchParams();
      var mapping = { filterPeriod:'period', filterSource:'source', filterServiceType:'serviceType', filterPayment:'paymentMethod', filterStatus:'paymentStatus', filterTechnician:'technician' };
      Object.keys(mapping).forEach(function (id) { var input = document.getElementById(id); if (input && !['all','custom','last_12_months'].includes(input.value)) params.set(mapping[id], input.value); });
      if (document.getElementById('filterPeriod')?.value === 'custom') ['From','To'].forEach(function (suffix) { var input = document.getElementById('filter' + suffix); if (input?.value) params.set(suffix.toLowerCase(), input.value); });
    }
    if (kind === 'technicians') ['department','rating','status','experience','sort'].forEach(function (key) { var input = document.getElementById(key === 'sort' ? 'sortBy' : key + 'Filter'); if (input?.value) params.set(key, input.value); });
    params.set('format','csv');
    var path = kind === 'overview' ? '/api/' + role + '/reports/overview' : kind === 'technicians' ? '/api/' + role + '/ratings/technicians'
      : kind === 'customers' ? '/api/' + role + '/reports/customers' + (profileId ? '/' + encodeURIComponent(profileId) : '')
      : kind === 'revenue' ? '/api/' + role + '/reports/revenue' : '/' + role + '/reports/' + kind + (['orders','service'].includes(kind) ? '/data' : '');
    return path + '?' + params.toString();
  }
  document.addEventListener('click', async function (event) {
    var button = event.target.closest('[data-report-csv]'); if (!button || button.disabled) return;
    var original = button.innerHTML, controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 90000);
    button.disabled = true; button.textContent = 'Preparing CSV...'; document.getElementById('reportCsvError')?.remove();
    try {
      var response = await fetch(exportUrl(), { credentials:'same-origin', signal:controller.signal });
      if (!response.ok) { var error = await response.json().catch(function () { return null; }); throw Error(error?.error || 'Could not download this report. Try again.'); }
      if (!(response.headers.get('content-type') || '').includes('text/csv')) throw Error('The report did not return a CSV file. Refresh and try again.');
      var url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = kind + '-report.csv';
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (error) {
      var box = document.createElement('div'); box.id = 'reportCsvError'; box.className = 'alert alert-danger mt-3'; box.setAttribute('role','alert');
      box.textContent = error.name === 'AbortError' ? 'The export took too long. Choose a smaller date range and try again.' : error.message; button.parentElement.insertAdjacentElement('afterend', box);
    } finally { clearTimeout(timer); button.disabled = false; button.innerHTML = original; }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach); else attach();
  new MutationObserver(attach).observe(document.documentElement, { childList:true, subtree:true });
})();
