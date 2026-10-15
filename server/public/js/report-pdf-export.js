(function () {
  'use strict';
  var match = window.location.pathname.match(/^\/(admin|secretary)\/reports\/(revenue|orders|service|inventory)\/?$/);
  if (!match) return;
  var role = match[1], kind = match[2];
  function attach() {
    if (document.querySelector('[data-report-pdf]')) return;
    var target = document.querySelector('.rr-actions, .sr-filter-actions, .au-hero-inner, .report-nav');
    if (!target) return;
    var button = document.createElement('button'); button.type = 'button'; button.className = kind === 'revenue' ? 'rr-btn light' : 'btn btn-outline-primary'; button.dataset.reportPdf = kind;
    button.innerHTML = '<i class="bi bi-file-earmark-pdf me-1" aria-hidden="true"></i>Export PDF';
    target.appendChild(button);
  }
  function exportUrl() {
    var params = new URLSearchParams(window.location.search);
    var form = document.getElementById(kind === 'orders' ? 'orderReportFilter' : 'serviceReportFilters');
    if (form) new FormData(form).forEach(function (value, key) { if (typeof value === 'string') params.set(key, value); });
    if (kind === 'revenue') {
      params = new URLSearchParams();
      var mapping = { filterPeriod: 'period', filterSource: 'source', filterServiceType: 'serviceType', filterPayment: 'paymentMethod', filterStatus: 'paymentStatus', filterTechnician: 'technician' };
      Object.keys(mapping).forEach(function (id) { var input = document.getElementById(id); if (input && !['all', 'custom', 'last_12_months'].includes(input.value)) params.set(mapping[id], input.value); });
      if (document.getElementById('filterPeriod').value === 'custom') ['From', 'To'].forEach(function (part) { var input = document.getElementById('filter' + part); if (input && input.value) params.set(part.toLowerCase(), input.value); });
    }
    params.set('format', 'pdf');
    var path = kind === 'revenue' ? '/api/' + role + '/reports/revenue'
      : '/' + role + '/reports/' + kind + (['orders', 'service'].includes(kind) ? '/data' : '');
    return path + '?' + params.toString();
  }
  document.addEventListener('click', async function (event) {
    var button = event.target.closest('[data-report-pdf]'); if (!button || button.disabled) return;
    var original = button.innerHTML; button.disabled = true; button.textContent = 'Preparing PDF…';
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 90000);
    var errorBox = document.getElementById('reportPdfError'); if (errorBox) errorBox.remove();
    try {
      var response = await fetch(exportUrl(), { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) await RACSRequest.read(response);
      if (!(response.headers.get('content-type') || '').includes('application/pdf')) throw new Error('The report could not be exported. Please refresh and try again.');
      var blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = kind + '-report.pdf'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (error) {
      errorBox = document.createElement('div'); errorBox.id = 'reportPdfError'; errorBox.className = 'alert alert-danger mt-3'; errorBox.setAttribute('role', 'alert');
      errorBox.textContent = error.name === 'AbortError' ? 'Report export took too long. Narrow the date range and try again.' : error.message;
      button.parentElement.insertAdjacentElement('afterend', errorBox);
    } finally { clearTimeout(timer); button.disabled = false; button.innerHTML = original; }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach); else attach();
  new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true });
})();
