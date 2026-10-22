(() => {
  'use strict';
  const modal = document.getElementById('ttExtraModal');
  if (!modal) return;
  const $ = name => document.getElementById('ttExtra' + name);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const state = { sequence: 0, saving: false, loading: false, jobs: [], equipment: [], stock: [], stockCheckout: {}, submissionId: '' };
  const error = message => { $('Error').textContent = message || ''; $('Error').hidden = !message; };
  function source() {
    const company = $('Source').value === 'company', borrowed = $('Source').value === 'borrowed';
    const stock = company && $('Equipment').value.startsWith('stock:');
    const work = state.jobs.find(job => job.type + ':' + job.id === $('Work').value);
    $('Company').hidden = !company; $('Manual').hidden = company; $('OwnerWrap').hidden = !borrowed;
    $('Equipment').required = company; $('Equipment').disabled = !company || state.loading;
    $('Name').required = !company; $('Name').disabled = company;
    $('Owner').required = borrowed; $('Owner').disabled = !borrowed;
    $('ReceiptWrap').hidden = !stock; $('Receipt').disabled = !stock; $('Receipt').required = stock;
    $('Reload').disabled = state.loading || state.saving;
    $('QuantityLabel').textContent = stock ? 'Quantity to check out and use' : 'Quantity used';
    $('StockHint').textContent = stock ? 'Check out & record will move the selected quantity into your custody and save its use for this job. Return the equipment through My Tools after work.' : company ? 'Equipment already with you is linked to this job without another checkout. It still follows the return process.' : 'Personal and borrowed tools do not change company stock or create a company return obligation.';
    $('Save').textContent = state.saving ? 'Saving…' : stock ? 'Check out & record' : 'Save record';
    $('Save').disabled = state.loading || state.saving || !state.jobs.length || (stock && (!state.stockCheckout.allowedDate || !work?.canCheckout));
    $('EquipmentHint').textContent = state.stockCheckout.allowedDate === false ? state.stockCheckout.message
      : work && !work.canCheckout ? 'This work is finished or paused. You can record equipment already issued; new stock checkouts require ongoing work today.'
      : 'Choose equipment already with you or available company stock. Reservations and equipment out of service are excluded from available quantities.';
    const item = stock ? state.stock.find(item => 'stock:' + item.id === $('Equipment').value) : state.equipment.find(item => item.id === $('Equipment').value);
    $('Quantity').max = company && item ? item.quantity : 10000;
    const units = Number($('Quantity').value) || 1;
    $('ReceiptLabel').textContent = `I physically received ${units} ${units === 1 ? 'unit' : 'units'} of ${item?.name || 'this equipment'} from company stock.`;
  }
  function equipmentOptions() {
    const selected = $('Equipment').value;
    const work = state.jobs.find(job => job.type + ':' + job.id === $('Work').value);
    const disabledStock = !state.stockCheckout.allowedDate || !work?.canCheckout;
    $('Equipment').innerHTML = '<option value="">Choose company equipment</option>'
      + '<optgroup label="Already issued to me">' + state.equipment.map(item => `<option value="${escape(item.id)}" ${item.returnPending || item.resolutionState === 'processing' ? 'disabled' : ''}>${escape(item.name)}${item.code ? ' · ' + escape(item.code) : ''} · ${escape(item.quantity)} issued${item.returnPending ? ' · Awaiting receipt' : ''}</option>`).join('') + '</optgroup>'
      + '<optgroup label="Available in company stock">' + state.stock.map(item => `<option value="stock:${escape(item.id)}" ${disabledStock ? 'disabled' : ''}>${escape(item.name)}${item.code ? ' · ' + escape(item.code) : ''} · ${escape(item.quantity)} available</option>`).join('') + '</optgroup>';
    if ([...$('Equipment').options].some(option => option.value === selected)) $('Equipment').value = selected;
    source();
  }
  async function options({ keepSelection = false } = {}) {
    const previousWork = keepSelection ? $('Work').value : '';
    const previousEquipment = keepSelection ? $('Equipment').value : '';
    const sequence = ++state.sequence;
    state.loading = true; state.jobs = []; state.equipment = []; state.stock = []; state.stockCheckout = {};
    $('Receipt').checked = false;
    $('Work').disabled = true; $('Save').disabled = true;
    $('Work').innerHTML = '<option value="">Loading work…</option>';
    $('Equipment').innerHTML = '<option value="">Loading equipment…</option>'; source(); error('');
    try {
      const response = await fetch('/api/technician/equipment-usage/extra-options?date=' + encodeURIComponent($('Date').value), { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load your work and equipment. Choose the date again to retry.');
      if (sequence !== state.sequence) return;
      state.jobs = data.jobs || []; state.equipment = data.equipment || []; state.stock = data.stockEquipment || []; state.stockCheckout = data.stockCheckout || {};
      $('Work').innerHTML = '<option value="">Choose booking or order</option>' + state.jobs.map(job => `<option value="${escape(job.type + ':' + job.id)}">${escape(job.reference)} · ${escape(job.name)}</option>`).join('');
      if ([...$('Work').options].some(option => option.value === previousWork)) $('Work').value = previousWork;
      equipmentOptions();
      if ([...$('Equipment').options].some(option => option.value === previousEquipment)) $('Equipment').value = previousEquipment;
      $('WorkHint').textContent = state.jobs.length ? 'Only your started or completed work on this date is listed.' : 'No started or completed booking/order was found for this date. Choose the date of the work you performed.';
      $('Work').disabled = !state.jobs.length; $('Save').disabled = !state.jobs.length;
    } catch (failure) {
      if (sequence !== state.sequence) return;
      $('Work').innerHTML = '<option value="">Work could not be loaded</option>';
      $('Equipment').innerHTML = '<option value="">Equipment could not be loaded</option>';
      error(failure.message);
    } finally { if (sequence === state.sequence) { state.loading = false; source(); } }
  }
  document.getElementById('ttRecordExtra').addEventListener('click', () => {
    $('Form').reset(); error(''); state.submissionId = crypto.randomUUID();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    $('Date').value = $('Date').max = today;
    bootstrap.Modal.getOrCreateInstance(modal).show(); options();
  });
  $('Date').addEventListener('change', options);
  $('Reload').addEventListener('click', () => options({ keepSelection: true }));
  $('Source').addEventListener('change', () => { $('Receipt').checked = false; source(); });
  $('Work').addEventListener('change', () => { $('Receipt').checked = false; equipmentOptions(); });
  $('Quantity').addEventListener('input', () => { $('Receipt').checked = false; source(); });
  $('Equipment').addEventListener('change', () => { $('Quantity').value = '1'; $('Receipt').checked = false; source(); });
  modal.addEventListener('shown.bs.modal', () => $('Date').focus());
  modal.addEventListener('hide.bs.modal', event => { if (state.saving) event.preventDefault(); else state.sequence++; });
  $('Form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.loading || state.saving || !$('Form').reportValidity()) return;
    const [workType, workId] = $('Work').value.split(':');
    const stock = $('Source').value === 'company' && $('Equipment').value.startsWith('stock:');
    const body = { date: $('Date').value, workType, workId, source: $('Source').value,
      companyMode: stock ? 'stock' : 'held', inventoryItemId: stock ? $('Equipment').value.slice(6) : undefined,
      equipmentAssignmentId: stock ? undefined : $('Equipment').value, receiptConfirmed: stock && $('Receipt').checked,
      equipmentName: $('Name').value.trim(), owner: $('Owner').value.trim(),
      quantity: Number($('Quantity').value), notes: $('Notes').value.trim(), clientSubmissionId: state.submissionId };
    state.saving = true; error(''); $('Save').textContent = 'Saving…';
    modal.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = true; });
    try {
      const response = await fetch('/api/technician/equipment-usage/extra', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save the equipment record. Please try again.');
      state.saving = false;
      bootstrap.Modal.getOrCreateInstance(modal).hide();
      window.dispatchEvent(new CustomEvent('technician-extra-equipment-saved', { detail: data.item }));
    } catch (failure) { error(failure.message); }
    finally {
      state.saving = false;
      modal.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = false; });
      $('Work').disabled = !state.jobs.length; $('Save').disabled = !state.jobs.length; source();
    }
  });
})();
