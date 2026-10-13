(() => {
  'use strict';
  const panel = document.getElementById('kitReturnsPanel');
  if (!panel) return;
  const technician = panel.dataset.mode === 'technician', base = technician ? '/api/technician/kit-returns' : '/api/admin/appointments/kit-returns';
  const canReview = !technician && panel.dataset.reviewAllowed === 'true';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  const keys = ['unused', 'used', 'damaged', 'missing'];
  const date = value => value ? new Date(value).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' }) : 'No date';
  const state = { page: 1, pages: 1, reportTotal: 0, materialPage: 1, materialPages: 1, materialTotal: 0, reports: [], materials: [], materialSelection: new Map(), reviewSelection: new Map(), selected: null, saving: false, loading: false, selecting: false };
  function message(id, text) { $(id).textContent = text || ''; $(id).hidden = !text; }
  async function request(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not load or save this return. Please try again.');
    return data;
  }
  const amount = value => Number(value || 0).toLocaleString('en-PH', { maximumFractionDigits: 3 });
  const materialKey = row => `${row.kitId}:${row._id}`;
  const returnable = row => Number(row.available) > 0 && !Number(row.returnPendingQuantity);
  function selectionControls() {
    const busy = state.loading || state.saving || state.selecting;
    if (!technician) {
      if (!canReview) return;
      const pending = $('krStatus').value === 'pending';
      $('krReviewActions').hidden = !pending; $('krReviewSelectionHint').hidden = !pending;
      const rows = state.reports.filter(row => row.status === 'pending'), count = rows.filter(row => state.reviewSelection.has(row._id)).length;
      $('krReviewSelectedCount').textContent = `${state.reviewSelection.size} selected`;
      $('krSelectReportsPage').checked = rows.length > 0 && count === rows.length;
      $('krSelectReportsPage').indeterminate = count > 0 && count < rows.length;
      $('krSelectReportsPage').disabled = busy || !rows.length;
      $('krClearReviewSelection').hidden = !state.reviewSelection.size;
      $('krClearReviewSelection').disabled = busy;
      $('krReviewSelected').disabled = busy || !state.reviewSelection.size;
      $('krReviewAll').disabled = busy || !state.reportTotal;
      $('krReviewAll').textContent = state.selecting ? 'Loading reports...' : 'Review all';
      panel.querySelectorAll('[data-select-report]').forEach(input => { input.disabled = busy; input.checked = state.reviewSelection.has(input.dataset.selectReport); });
      return;
    }
    const rows = state.materials.filter(returnable), count = rows.filter(row => state.materialSelection.has(materialKey(row))).length;
    $('krSelectedCount').textContent = `${state.materialSelection.size} selected`;
    $('krSelectPage').checked = rows.length > 0 && count === rows.length;
    $('krSelectPage').indeterminate = count > 0 && count < rows.length;
    $('krSelectPage').disabled = busy || !rows.length;
    $('krClearSelection').hidden = !state.materialSelection.size;
    $('krClearSelection').disabled = busy;
    $('krReturnSelected').disabled = busy || !state.materialSelection.size;
    $('krReturnAll').disabled = busy || !state.materialTotal;
    $('krReturnAll').textContent = state.selecting ? 'Loading materials...' : 'Return all';
    panel.querySelectorAll('[data-select-material]').forEach(input => { input.disabled = busy; input.checked = state.materialSelection.has(input.dataset.selectMaterial); });
  }
  const jobs = row => [...(row.bookingIds || []), ...(row.orderIds || [])].map(job => '<span class="kr-job-ref">' + escape(job.bookingReference || job.orderReference || 'Linked job') + (job.status === 'cancelled' ? ' <span class="badge bg-secondary">Cancelled</span>' : '') + '</span>').join('') || '<span class="kr-job-ref">Shared Daily Kit</span>';
  const quantities = row => '<div class="kr-quantity-grid">' + keys.map(key => '<span>' + ({ unused: row.category === 'equipment' ? 'Usable' : 'Unused', used: 'Used', damaged: 'Damaged', missing: 'Missing' })[key] + '<b>' + amount(row[key]) + '</b></span>').join('') + '</div><small>' + escape(row.unit || 'pcs') + '</small>';
  function renderReports(data) {
    state.reports = data.items || []; state.pages = data.pagination.pages;
    state.reportTotal = data.pagination.total;
    state.reports.forEach(row => { if (row.status !== 'pending') state.reviewSelection.delete(row._id); else if (state.reviewSelection.has(row._id)) state.reviewSelection.set(row._id, row); });
    $('krTotal').textContent = data.pagination.total;
    $('krReports').innerHTML = state.reports.map(row => {
      const statusClass = row.status === 'pending' ? 'bg-warning text-dark' : row.status === 'received' ? 'bg-success' : 'bg-danger';
      const statusLabel = row.status === 'pending' ? 'Awaiting admin receipt' : row.status === 'received' ? 'Admin confirmed' : 'Needs correction';
      const useLabel = row.category === 'equipment' && row.equipmentUse && row.equipmentUse !== 'not_recorded' ? '<small>' + (row.equipmentUse === 'unused' ? 'Equipment was not used' : 'Equipment was used') + '</small>' : '';
      const action = canReview && row.status === 'pending' ? '<button class="btn btn-success btn-sm" type="button" data-review="' + escape(row._id) + '">Review return</button>' : row.receivedAt ? escape(date(row.receivedAt)) : '&mdash;';
      const checkbox = canReview && row.status === 'pending' ? '<label class="kr-material-choice"><input type="checkbox" class="form-check-input kr-material-check" data-select-report="' + escape(row._id) + '" aria-label="Select return of ' + escape(row.name) + ' by ' + escape(row.technicianId?.name || 'technician') + '"></label>' : '';
      return '<tr><td class="kr-report-item"><div class="kr-material-name">' + checkbox + '<div><strong>' + escape(row.name) + '</strong><small>' + escape(row.technicianId?.name || 'Your report') + ' &middot; ' + escape(date(row.createdAt)) + '</small>' + useLabel + (row.notes ? '<small class="kr-report-note">' + (technician ? 'Your report: ' : 'Technician report: ') + escape(row.notes) + '</small>' : '') + (row.receiptNotes ? '<small class="kr-report-note">Admin feedback: ' + escape(row.receiptNotes) + '</small>' : '') + '</div></div></td><td data-label="Linked work">' + jobs(row) + '</td><td data-label="Reported quantities">' + quantities(row) + '</td><td data-label="Status"><span class="badge ' + statusClass + '">' + statusLabel + '</span></td><td data-label="' + (technician ? 'Reviewed' : 'Action') + '">' + action + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="kr-empty"><i class="bi bi-inbox" aria-hidden="true"></i>No return reports in this view.</td></tr>';
    $('krPrev').disabled = state.page <= 1; $('krNext').disabled = state.page >= state.pages;
    $('krPageLabel').textContent = 'Page ' + state.page + ' of ' + state.pages + ' - 10 per page';
  }
  function renderMaterials(data) {
    state.materials = data.items || [];
    state.materialPages = data.pagination.pages;
    state.materialTotal = data.pagination.total;
    state.materials.forEach(row => { const key = materialKey(row); if (!returnable(row)) state.materialSelection.delete(key); else if (state.materialSelection.has(key)) state.materialSelection.set(key, row); });
    $('krMaterialPage').textContent = 'Page ' + state.materialPage + ' of ' + state.materialPages + ' - ' + data.pagination.total + ' materials';
    $('krMaterialPrev').disabled = state.materialPage <= 1; $('krMaterialNext').disabled = state.materialPage >= state.materialPages;
    $('krMaterials').innerHTML = state.materials.map(row => {
      const action = row.returnPendingQuantity ? '<span class="badge bg-warning text-dark">Awaiting admin receipt</span>' : '<button class="btn btn-outline-success btn-sm" type="button" data-material="' + escape(row.kitId) + ':' + escape(row._id) + '">Report materials</button>';
      const checkbox = returnable(row) ? '<label class="kr-material-choice"><input type="checkbox" class="form-check-input kr-material-check" data-select-material="' + escape(materialKey(row)) + '" aria-label="Select ' + escape(row.name) + ' for ' + escape(date(row.workDate)) + '"></label>' : '';
      return '<tr><td class="kr-report-item"><div class="kr-material-name">' + checkbox + '<div><strong>' + escape(row.name) + '</strong><small>' + escape(date(row.workDate)) + ' &middot; ' + escape(row.unit || 'pcs') + '</small>' + (row.cancelledWork ? '<small class="text-danger">Cancelled job &middot; Check unused materials</small>' : '') + '</div></div></td><td data-label="Issued">' + amount(row.quantityIssued) + '</td><td data-label="Recorded used">' + amount(row.quantityUsed) + '</td><td data-label="Still with you">' + amount(row.outstanding) + (row.returnPendingQuantity ? '<small>' + amount(row.returnPendingQuantity) + ' awaiting receipt</small>' : '') + '</td><td>' + action + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="kr-empty"><i class="bi bi-check2-circle" aria-hidden="true"></i>No materials waiting for a report.</td></tr>';
  }
  async function load() {
    if (state.loading || state.saving || state.selecting) return;
    state.loading = true; $('krRefresh').disabled = true; $('krStatus').disabled = true;
    selectionControls();
    try {
      const results = await Promise.allSettled([request(`${base}?status=${encodeURIComponent($('krStatus').value)}&page=${state.page}`), technician ? request(`${base}/materials?page=${state.materialPage}`) : Promise.resolve(null)]);
      const errors = [];
      if (results[0].status === 'fulfilled') {
        let reports = results[0].value;
        if (state.page > reports.pagination.pages) { state.page = reports.pagination.pages; reports = await request(`${base}?status=${encodeURIComponent($('krStatus').value)}&page=${state.page}`); }
        renderReports(reports);
      } else errors.push(results[0].reason.message);
      if (technician && results[1].status === 'fulfilled') renderMaterials(results[1].value); else if (results[1].status === 'rejected') errors.push(results[1].reason.message);
      message('krError', errors.join(' '));
    } catch (error) { message('krError', error.message); }
    finally { state.loading = false; $('krRefresh').disabled = false; $('krStatus').disabled = false; selectionControls(); }
  }
  function open(row, reporting) {
    state.selected = { row, reporting }; $('krForm').reset(); message('krModalError', '');
    $('krBulkItems').hidden = true; $('krBulkItems').innerHTML = '';
    $('krItem').textContent = row.name;
    const isEquipment = !reporting && row.category === 'equipment';
    $('krQuantities').hidden = isEquipment; $('krConditionWrap').hidden = !isEquipment;
    keys.forEach(key => { $('kr-' + key).value = reporting ? key === 'unused' ? row.available : 0 : Number(row[key] || 0); $('kr-' + key).disabled = isEquipment; });
    $('krCondition').value = row.condition || 'good';
    $('krConfirmWrap').hidden = reporting; $('krReject').hidden = reporting;
    $('krModalTitle').textContent = reporting ? 'Report unused materials' : 'Receive and check return';
    $('krBalance').textContent = reporting ? `Issued: ${row.quantityIssued}. Already recorded used: ${row.quantityUsed || 0}. Not accounted for: ${row.outstanding}. Do not enter recorded usage again. Report additional used items only after the linked work ends or is cancelled.` : `Technician reported ${keys.map(key => `${key}: ${row[key] || 0}`).join(', ')}. ${row.notes || ''} Check the physical items. Only usable unused items return to stock.`;
    $('krSave').textContent = reporting ? 'Send report' : 'Confirm receipt';
    bootstrap.Modal.getOrCreateInstance($('krModal')).show();
  }
  function openBatch(rows) {
    if (!rows.length) { message('krError', 'No materials are available to return. Items already awaiting admin receipt are skipped.'); return; }
    state.selected = { rows, reporting: true, bulk: true };
    $('krForm').reset(); message('krModalError', ''); message('krError', '');
    $('krModalTitle').textContent = 'Return materials';
    $('krItem').textContent = `${rows.length} material${rows.length === 1 ? '' : 's'} selected`;
    $('krBalance').textContent = 'Check the unused quantities below. Adjust any used, damaged, or missing amounts and explain them in Notes. Do not count recorded usage again. Admin will check each report before updating stock.';
    $('krQuantities').hidden = true; keys.forEach(key => { $('kr-' + key).disabled = true; });
    $('krConditionWrap').hidden = true; $('krConfirmWrap').hidden = true; $('krReject').hidden = true;
    $('krBulkItems').hidden = false;
    const labels = { unused: 'Unused and usable', used: 'Additional used', damaged: 'Damaged', missing: 'Missing' };
    $('krBulkItems').innerHTML = rows.map((row, index) => '<section class="kr-bulk-item" data-bulk-index="' + index + '"><h6>' + escape(row.name) + ' <small>' + escape(row.unit || 'pcs') + '</small></h6><p>' + escape(date(row.workDate)) + ' &middot; Issued: ' + amount(row.quantityIssued) + ' &middot; Recorded used: ' + amount(row.quantityUsed) + ' &middot; Available: ' + amount(row.available) + '</p><div class="kr-quantities">' + keys.map(key => '<label class="form-label" for="kr-bulk-' + index + '-' + key + '">' + labels[key] + '<input class="form-control mt-1" type="number" id="kr-bulk-' + index + '-' + key + '" data-quantity="' + key + '" min="0" max="' + Number(row.available) + '" step="any" value="' + (key === 'unused' ? Number(row.available) : 0) + '" required></label>').join('') + '</div></section>').join('');
    $('krSave').textContent = 'Send return reports';
    bootstrap.Modal.getOrCreateInstance($('krModal')).show();
  }
  async function selectAllMaterials() {
    if (state.loading || state.saving || state.selecting) return;
    state.selecting = true; selectionControls(); message('krError', '');
    try {
      const data = await request(`${base}/materials?selection=all`);
      openBatch((data.items || []).filter(returnable));
    } catch (error) { message('krError', error.message); }
    finally { state.selecting = false; selectionControls(); }
  }
  function openReviewBatch(rows) {
    if (!rows.length) { message('krError', 'There are no pending reports to review.'); return; }
    state.selected = { rows, reporting: false, reviewBulk: true };
    $('krForm').reset(); message('krModalError', ''); message('krError', '');
    $('krModalTitle').textContent = 'Review returned items';
    $('krItem').textContent = `${rows.length} return report${rows.length === 1 ? '' : 's'} selected`;
    $('krBalance').textContent = 'Check each item and technician below. Correct quantities or equipment conditions as needed. Confirm receipt only after checking the items. Use Needs correction to send these reports back without adding stock.';
    $('krQuantities').hidden = true; keys.forEach(key => { $('kr-' + key).disabled = true; });
    $('krConditionWrap').hidden = true; $('krConfirmWrap').hidden = false; $('krReject').hidden = false;
    $('krBulkItems').hidden = false;
    const labels = { unused: 'Unused and usable', used: 'Additional used', damaged: 'Damaged', missing: 'Missing' };
    $('krBulkItems').innerHTML = rows.map((row, index) => {
      const total = keys.reduce((sum, key) => sum + Number(row[key] || 0), 0);
      const fields = row.category === 'equipment' ? '<p>Reported condition: ' + escape(row.condition || 'good') + ' &middot; Quantity: ' + amount(total) + '</p><label class="form-label" for="kr-review-' + index + '-condition">Received condition<select class="form-select mt-1" id="kr-review-' + index + '-condition">' + [['good', 'Good'], ['fair', 'Fair'], ['damaged', 'Damaged'], ['lost', 'Missing / lost']].map(([value, label]) => '<option value="' + value + '"' + (value === (row.condition || 'good') ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>' : '<p>Total reported: ' + amount(total) + ' ' + escape(row.unit || 'pcs') + '</p><div class="kr-quantities">' + keys.map(key => '<label class="form-label" for="kr-review-' + index + '-' + key + '">' + labels[key] + '<input class="form-control mt-1" type="number" id="kr-review-' + index + '-' + key + '" min="0" max="' + total + '" step="any" value="' + Number(row[key] || 0) + '" required></label>').join('') + '</div>';
      return '<section class="kr-bulk-item"><h6>' + escape(row.name) + '</h6><p>' + escape(row.technicianId?.name || 'Technician') + ' &middot; ' + escape(date(row.createdAt)) + '</p>' + jobs(row) + (row.notes ? '<p class="kr-report-note">Technician report: ' + escape(row.notes) + '</p>' : '') + fields + '<label class="form-label mt-3" for="kr-review-' + index + '-notes">Notes for this item (optional)<textarea id="kr-review-' + index + '-notes" class="form-control mt-1" rows="2" maxlength="500" placeholder="Use the notes below for all items, or add a note here."></textarea></label></section>';
    }).join('');
    $('krSave').textContent = 'Confirm selected receipts';
    bootstrap.Modal.getOrCreateInstance($('krModal')).show();
  }
  async function selectAllReports() {
    if (state.loading || state.saving || state.selecting || !canReview) return;
    state.selecting = true; selectionControls(); message('krError', '');
    try { const data = await request(`${base}?selection=all`); openReviewBatch((data.items || []).filter(row => row.status === 'pending')); }
    catch (error) { message('krError', error.message); }
    finally { state.selecting = false; selectionControls(); }
  }
  async function save(decision) {
    if (state.saving || !state.selected) return;
    const { row, rows, reporting, bulk, reviewBulk } = state.selected;
    if (!reporting && decision === 'receive' && !$('krConfirm').checked) { message('krModalError', 'Confirm that you checked the returned items first.'); return; }
    const qty = Object.fromEntries(keys.map(key => [key, Number($('kr-' + key).value)]));
    const notes = $('krNotes').value.trim();
    let items;
    if (reviewBulk) {
      if (decision === 'receive' && !$('krForm').reportValidity()) return;
      items = rows.map((item, index) => ({ reportId: item._id, notes: $(`kr-review-${index}-notes`).value.trim() || notes, ...(item.category === 'equipment' ? { condition: $(`kr-review-${index}-condition`).value } : decision === 'receive' ? { quantities: Object.fromEntries(keys.map(key => [key, Number($(`kr-review-${index}-${key}`).value)])) } : {}) }));
      for (const [index, item] of items.entries()) {
        if (decision === 'reject' && !item.notes) { message('krModalError', 'Explain what needs correction for each item, or add a note for all items below.'); return; }
        if (decision !== 'receive' || !item.quantities) continue;
        const values = keys.map(key => item.quantities[key]), total = values.reduce((sum, value) => sum + value, 0), reported = keys.reduce((sum, key) => sum + Number(rows[index][key] || 0), 0);
        if (values.some(value => !Number.isFinite(value) || value < 0) || total <= 0 || Math.abs(total - reported) > 1e-9) { message('krModalError', `${rows[index].name}: quantities must add up to the reported total of ${reported}. Use Needs correction if the total is wrong.`); return; }
      }
    }
    if (bulk) {
      if (!$('krForm').reportValidity()) return;
      items = rows.map((item, index) => ({ kitId: item.kitId, itemId: item._id, ...Object.fromEntries(keys.map(key => [key, Number($(`kr-bulk-${index}-${key}`).value)])) }));
      for (const [index, item] of items.entries()) {
        const values = keys.map(key => item[key]), total = values.reduce((sum, value) => sum + value, 0);
        if (values.some(value => !Number.isFinite(value) || value < 0) || total <= 0 || total > Number(rows[index].available) + 1e-9) { message('krModalError', `Check the quantities for ${rows[index].name}. The total must be greater than zero and no more than ${rows[index].available}.`); return; }
        if ((item.used || item.damaged || item.missing) && !notes) { message('krModalError', 'Add notes explaining any additional used, damaged, or missing materials.'); return; }
      }
    }
    if (decision === 'reject' && !reviewBulk && !notes) { message('krModalError', 'Explain what needs correction.'); return; }
    state.saving = true;
    selectionControls();
    $('krForm').querySelectorAll('button').forEach(button => { button.disabled = true; }); message('krModalError', '');
    $('krSave').textContent = 'Saving…';
    try {
      const body = reviewBulk ? { items, decision, notes, confirmedReceived: $('krConfirm').checked } : bulk ? { items, notes } : reporting ? { kitId: row.kitId, itemId: row._id, ...qty, notes } : { decision, quantities: row.category === 'equipment' ? undefined : qty, condition: row.category === 'equipment' ? $('krCondition').value : undefined, notes };
      const result = await request(reviewBulk ? base + '/review-batch' : bulk ? base + '/materials/batch' : reporting ? base + '/materials' : base + '/' + encodeURIComponent(row._id) + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (reporting) (bulk ? rows : [row]).forEach(item => state.materialSelection.delete(materialKey(item)));
      else (reviewBulk ? rows : [row]).forEach(item => state.reviewSelection.delete(item._id));
      state.saving = false; bootstrap.Modal.getOrCreateInstance($('krModal')).hide();
      window.dispatchEvent(new Event('inventory:changed'));
      await load();
      if (window.notify && typeof window.notify.success === 'function') window.notify.success(result.message);
    } catch (error) { message('krModalError', error.message); }
    finally { state.saving = false; $('krForm').querySelectorAll('button').forEach(button => { button.disabled = false; }); $('krSave').textContent = reviewBulk ? 'Confirm selected receipts' : bulk ? 'Send return reports' : reporting ? 'Send report' : 'Confirm receipt'; selectionControls(); }
  }
  panel.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || state.loading || state.saving || state.selecting) return;
    if (button.dataset.material) { const row = state.materials.find(item => `${item.kitId}:${item._id}` === button.dataset.material); if (row) open(row, true); }
    if (button.dataset.review) { const row = state.reports.find(item => item._id === button.dataset.review); if (row) open(row, false); }
  });
  $('krForm').addEventListener('submit', event => { event.preventDefault(); save('receive'); });
  $('krReject').addEventListener('click', () => save('reject'));
  $('krRefresh').addEventListener('click', load);
  $('krStatus').addEventListener('change', () => { state.page = 1; state.reviewSelection.clear(); selectionControls(); load(); });
  $('krPrev').addEventListener('click', () => { if (!state.loading && state.page > 1) { state.page--; load(); } });
  $('krNext').addEventListener('click', () => { if (!state.loading && state.page < state.pages) { state.page++; load(); } });
  if (technician) {
    panel.addEventListener('change', event => {
      const input = event.target.closest('[data-select-material]');
      if (!input || state.loading || state.saving || state.selecting) return;
      const row = state.materials.find(item => materialKey(item) === input.dataset.selectMaterial);
      if (row && returnable(row)) {
        if (input.checked && state.materialSelection.size >= 100) { input.checked = false; message('krError', 'Select up to 100 materials at a time.'); }
        else if (input.checked) state.materialSelection.set(materialKey(row), row); else state.materialSelection.delete(materialKey(row));
      }
      selectionControls();
    });
    $('krSelectPage').addEventListener('change', event => {
      if (state.loading || state.saving || state.selecting) return;
      const rows = state.materials.filter(returnable);
      const additions = rows.filter(row => !state.materialSelection.has(materialKey(row)));
      if (event.target.checked && state.materialSelection.size + additions.length > 100) { message('krError', 'Select up to 100 materials at a time.'); selectionControls(); return; }
      rows.forEach(row => event.target.checked ? state.materialSelection.set(materialKey(row), row) : state.materialSelection.delete(materialKey(row)));
      selectionControls();
    });
    $('krClearSelection').addEventListener('click', () => { state.materialSelection.clear(); selectionControls(); });
    $('krReturnSelected').addEventListener('click', () => { if (!state.loading && !state.saving && !state.selecting) openBatch([...state.materialSelection.values()]); });
    $('krReturnAll').addEventListener('click', selectAllMaterials);
    $('krMaterialPrev').addEventListener('click', () => { if (!state.loading && state.materialPage > 1) { state.materialPage--; load(); } });
    $('krMaterialNext').addEventListener('click', () => { if (!state.loading && state.materialPage < state.materialPages) { state.materialPage++; load(); } });
  } else if (canReview) {
    panel.addEventListener('change', event => {
      const input = event.target.closest('[data-select-report]'); if (!input || state.loading || state.saving || state.selecting) return;
      const row = state.reports.find(item => item._id === input.dataset.selectReport);
      if (row?.status === 'pending') {
        if (input.checked && state.reviewSelection.size >= 100) { input.checked = false; message('krError', 'Select up to 100 reports at a time.'); }
        else if (input.checked) state.reviewSelection.set(row._id, row); else state.reviewSelection.delete(row._id);
      }
      selectionControls();
    });
    $('krSelectReportsPage').addEventListener('change', event => {
      if (state.loading || state.saving || state.selecting) return;
      const rows = state.reports.filter(row => row.status === 'pending');
      if (event.target.checked && state.reviewSelection.size + rows.filter(row => !state.reviewSelection.has(row._id)).length > 100) { message('krError', 'Select up to 100 reports at a time.'); selectionControls(); return; }
      rows.forEach(row => event.target.checked ? state.reviewSelection.set(row._id, row) : state.reviewSelection.delete(row._id)); selectionControls();
    });
    $('krClearReviewSelection').addEventListener('click', () => { state.reviewSelection.clear(); selectionControls(); });
    $('krReviewSelected').addEventListener('click', () => { if (!state.loading && !state.saving && !state.selecting) openReviewBatch([...state.reviewSelection.values()]); });
    $('krReviewAll').addEventListener('click', selectAllReports);
  }
  $('krModal').addEventListener('hide.bs.modal', event => { if (state.saving) event.preventDefault(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  window.addEventListener('notification:new', () => { if (!document.hidden) load(); });
  if (window.socket) window.socket.on('notification:new', data => {
    if (['kit_return_reported', 'kit_return_reviewed', 'equipment_return_resolved'].includes(data?.type) && !document.hidden && !$('krModal').classList.contains('show')) load();
  });
  window.setInterval(() => { if (!document.hidden && !$('krModal').classList.contains('show')) load(); }, 60000);
  load();
})();
