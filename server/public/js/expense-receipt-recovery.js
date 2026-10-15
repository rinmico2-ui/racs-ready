(function () {
  'use strict';
  const forms = new WeakMap();
  function clear(container) {
    forms.get(container)?.controller.abort();
    forms.delete(container);
    container.replaceChildren();
  }
  function show(container, expense, options) {
    clear(container);
    if (!options.allowed || !/^[a-f0-9]{24}$/i.test(String(expense?._id || ''))) return;
    if (!/^\/(?:uploads\/expense-receipts\/expense-\d+-\d+\.(?:jpe?g|png|webp|pdf)|api\/receipts\/[a-f0-9]{24})$/i.test(expense.receiptImage || '')) return;
    const state = { controller: new AbortController(), saving: false };
    forms.set(container, state);
    const form = document.createElement('form');
    form.className = 'border-top mt-3 pt-3';
    const note = document.createElement('p');
    note.className = 'small text-muted';
    note.textContent = 'Restore this receipt using the original file from a backup or the person who submitted it.';
    const label = document.createElement('label');
    label.className = 'form-label small fw-semibold';
    label.textContent = 'Original receipt (JPG, PNG, WEBP or PDF, up to 5 MB)';
    const file = document.createElement('input');
    file.type = 'file'; file.accept = 'image/jpeg,image/png,image/webp,application/pdf'; file.required = true;
    file.className = 'form-control form-control-sm'; label.appendChild(file);
    const confirmation = document.createElement('label');
    confirmation.className = 'small d-flex gap-2 align-items-start my-3';
    const check = document.createElement('input'); check.type = 'checkbox'; check.required = true; check.className = 'form-check-input mt-1';
    confirmation.append(check, document.createTextNode('I confirm this is the original receipt for this expense.'));
    const message = document.createElement('div'); message.setAttribute('role', 'status'); message.className = 'small mb-2';
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn btn-sm btn-primary'; submit.textContent = 'Restore original receipt';
    form.append(note, label, confirmation, message, submit); container.appendChild(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (state.saving || !form.reportValidity()) return;
      const original = file.files[0];
      if (!original || original.size > 5 * 1024 * 1024) { message.textContent = 'Choose a receipt no larger than 5 MB.'; return; }
      state.saving = true; submit.disabled = true; submit.textContent = 'Restoring receipt...'; message.textContent = '';
      const body = new FormData(); body.append('receipt', original); body.append('confirmOriginal', 'true');
      try {
        const response = await fetch(`${options.apiBase}/expenses/${expense._id}/receipt/recover`, { method: 'POST', body, credentials: 'same-origin', signal: state.controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'The receipt could not be restored. Please try again.');
        if (forms.get(container) !== state) return;
        clear(container);
        options.onRecovered();
      } catch (error) {
        if (!state.controller.signal.aborted && forms.get(container) === state) message.textContent = error.message;
      } finally {
        state.saving = false;
        if (forms.get(container) === state) { submit.disabled = false; submit.textContent = 'Restore original receipt'; }
      }
    });
  }
  window.expenseReceiptRecovery = { show, clear };
})();
