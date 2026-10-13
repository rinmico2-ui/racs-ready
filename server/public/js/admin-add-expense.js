(() => {
  'use strict';
  const form = document.getElementById('adminExpenseForm'), openButton = document.getElementById('adminAddExpense');
  if (!form || !openButton) return;
  const $ = id => document.getElementById(id), base = '/api/admin/appointments/expenses';
  let saving = false, loading = false, token = '', previewUrl = '';
  const error = text => { $('adminExpenseError').textContent = text || ''; $('adminExpenseError').hidden = !text; };
  async function request(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not save or load the expense. Please try again.');
    return data;
  }
  function fuelFields() {
    const fuel = $('aeType').value === 'fuel'; $('aeFuelFields').hidden = !fuel;
    $('aeFuelFields').querySelectorAll('input').forEach(input => { input.required = fuel; input.disabled = !fuel; });
  }
  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = ''; $('aeReceiptPreview').replaceChildren(); $('aeReceiptPreview').hidden = true;
  }
  async function loadOptions() {
    if (loading || saving) return;
    loading = true; $('aeSave').disabled = true; $('aeOptionsRetry').disabled = true;
    $('aeTechnician').disabled = true; $('aeBooking').disabled = true; $('aeOptionsNotice').hidden = true;
    try {
      const data = await request(base + '/options');
      $('aeTechnician').replaceChildren(new Option('Company expense', ''), ...(data.technicians || []).map(row => new Option(row.name, row._id)));
      $('aeBooking').replaceChildren(new Option('No linked booking', ''), ...(data.bookings || []).map(row => new Option([row.bookingReference || 'Booking', row.customer?.name, row.service?.name || row.services?.[0]?.name].filter(Boolean).join(' - '), row._id)));
      $('aeTechnician').disabled = false; $('aeBooking').disabled = false;
    } catch (e) {
      $('aeOptionsMessage').textContent = 'Could not load technician and booking choices. You can save a company expense or try again.'; $('aeOptionsNotice').hidden = false;
    } finally { loading = false; $('aeSave').disabled = false; $('aeOptionsRetry').disabled = false; }
  }
  openButton.addEventListener('click', () => {
    if (saving || loading) return;
    form.reset(); error(''); clearPreview(); token = crypto.randomUUID();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    $('aeDate').value = today; $('aeDate').max = today;
    $('aeTechnician').replaceChildren(new Option('Company expense', '')); $('aeBooking').replaceChildren(new Option('No linked booking', ''));
    fuelFields(); bootstrap.Modal.getOrCreateInstance($('adminExpenseModal')).show(); loadOptions();
  });
  $('aeType').addEventListener('change', fuelFields);
  $('aeOptionsRetry').addEventListener('click', loadOptions);
  $('aeReceipt').addEventListener('change', () => {
    clearPreview(); error(''); const file = $('aeReceipt').files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) { $('aeReceipt').value = ''; error('Choose a JPG, PNG, WEBP or PDF receipt, up to 5 MB.'); return; }
    const name = document.createElement('p'); name.textContent = file.name;
    if (file.type.startsWith('image/')) { previewUrl = URL.createObjectURL(file); const image = document.createElement('img'); image.src = previewUrl; image.alt = 'Selected expense receipt'; $('aeReceiptPreview').append(image); }
    $('aeReceiptPreview').append(name); $('aeReceiptPreview').hidden = false;
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving || loading || !form.reportValidity()) return;
    if (!$('aeDescription').value.trim()) { error('Enter an expense description.'); return; }
    const body = new FormData(form); body.set('submissionKey', token);
    saving = true; error(''); openButton.disabled = true;
    form.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = true; });
    $('aeSave').innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Saving...';
    try {
      await request(base, { method: 'POST', body });
      saving = false; bootstrap.Modal.getOrCreateInstance($('adminExpenseModal')).hide();
      window.dispatchEvent(new Event('expense:created'));
      if (typeof window.showNotification === 'function') window.showNotification({ type: 'success', title: 'Expense saved', message: 'The approved expense is now included in your records and totals.' });
    } catch (e) { error(e.message); }
    finally {
      saving = false; openButton.disabled = false;
      form.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = false; });
      fuelFields(); $('aeSave').innerHTML = '<i class="bi bi-check2" aria-hidden="true"></i> Save expense';
    }
  });
  $('adminExpenseModal').addEventListener('hide.bs.modal', event => { if (saving) event.preventDefault(); });
  $('adminExpenseModal').addEventListener('hidden.bs.modal', clearPreview);
})();
