(function () {
  'use strict';
  let initialized = false, target = null, revision = 0, ready = false, saving = false, photo = null, previewUrl = null, onCompleted = null;
  const el = name => document.getElementById('repairCompletion' + name);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const rows = () => [...el('ConsumablesList').querySelectorAll('input')];
  function update() {
    el('Submit').disabled = saving || !ready || !photo || rows().some(input => input.value.trim() === '' || !Number.isFinite(Number(input.value)) || Number(input.value) < 0 || Number(input.value) > Number(input.max));
  }
  function error(message) { el('Error').textContent = message; el('Error').hidden = false; }
  function preview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = photo ? URL.createObjectURL(photo) : null;
    el('Preview').hidden = !previewUrl;
    if (previewUrl) el('Preview').src = previewUrl; else el('Preview').removeAttribute('src');
  }
  async function load() {
    const current = ++revision, id = target;
    ready = false; el('Loading').hidden = false; el('Reload').hidden = true; el('Error').hidden = true; el('Details').hidden = true; update();
    try {
      const response = await fetch('/api/technician/appointments/' + encodeURIComponent(id) + '/completion-summary', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (current !== revision) return;
      if (!response.ok) throw new Error(data.error || 'Could not load the completion details.');
      el('Reference').textContent = data.bookingReference || 'REPAIR COMPLETION';
      el('Parts').hidden = !data.parts.length; el('Parts').open = false;
      el('NoParts').hidden = Boolean(data.parts.length);
      el('PartsCount').textContent = data.parts.length + ' item' + (data.parts.length === 1 ? '' : 's');
      el('PartsList').innerHTML = data.parts.map(part => '<div class="repair-completion-part"><span>' + esc(part.name) + '<small>' + esc(part.source) + '</small></span><strong>' + esc(part.quantity) + ' ' + esc(part.unit) + '</strong></div>').join('');
      el('Consumables').hidden = !data.consumables.length;
      el('ConsumablesList').innerHTML = data.consumables.map((item, index) => '<div class="repair-completion-consumable"><label for="rcUsed' + index + '">' + esc(item.itemName) + '<small>Available: ' + esc(item.available) + ' ' + esc(item.unit) + '</small></label><input id="rcUsed' + index + '" class="form-control" type="number" min="0" max="' + Number(item.available) + '" step="any" data-name="' + esc(item.itemName) + '" placeholder="0" required aria-label="' + esc(item.itemName) + ' used (' + esc(item.unit) + ')"></div>').join('');
      el('EquipmentNote').textContent = data.equipmentNote;
      el('Details').hidden = false;
      const missing = data.parts.filter(part => part.missing > 0);
      if (missing.length) throw new Error('Confirm the issued parts or nearby purchase before completion: ' + missing.map(part => part.name).join(', ') + '.');
      ready = true;
    } catch (failure) {
      if (current !== revision) return;
      error(failure.message || 'Could not load your issued inventory. Please try again.'); el('Reload').hidden = false;
    } finally { if (current === revision) { el('Loading').hidden = true; update(); } }
  }
  async function submit() {
    update(); if (el('Submit').disabled || !target) return;
    saving = true; window._repairCompletionSubmitting = true; el('Error').hidden = true;
    el('Submit').textContent = 'Completing repair…'; update();
    const finish = window.TechnicianWorkUpdates?.beginMutation();
    let saved = false;
    try {
      const body = new FormData(); body.append('proofPhoto', photo);
      body.append('consumables', JSON.stringify(rows().map(input => ({ itemName: input.dataset.name, quantityUsed: Number(input.value) }))));
      body.append('completionNotes', el('Notes').value.trim());
      const response = await fetch('/api/technician/appointments/' + encodeURIComponent(target) + '/complete-repair', { method: 'POST', credentials: 'same-origin', body });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not complete the repair.');
      saved = true; saving = false; window._repairCompletionSubmitting = false;
      bootstrap.Modal.getOrCreateInstance(document.getElementById('materialsModal')).hide();
      let refreshed;
      try { refreshed = await finish?.(); } catch (_) { refreshed = false; }
      if (onCompleted) await onCompleted(data);
      window._showNotification?.({ type: refreshed === false ? 'warning' : 'success', title: 'Repair Completed', message: refreshed === false ? 'Repair is saved. Refresh the assignments page to load the latest details.' : 'Completion photo and issued inventory usage recorded.', duration: 5000 });
    } catch (failure) {
      if (saved) window._showNotification?.({ type: 'warning', title: 'Repair Completed', message: 'The repair is saved. Refresh to see the latest details.', duration: 6000 });
      else { error(failure.message || 'Unable to complete the repair. Please try again.'); finish?.(false); }
    } finally { saving = false; window._repairCompletionSubmitting = false; el('Submit').textContent = 'Submit & Complete Repair'; update(); }
  }
  function init() {
    if (initialized) return; initialized = true;
    el('Reload').addEventListener('click', load);
    el('Submit').addEventListener('click', submit);
    el('ConsumablesList').addEventListener('input', update);
    el('Photo').addEventListener('change', function () {
      const file = this.files[0]; photo = null; el('Error').hidden = true;
      if (file && (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) { this.value = ''; error('Choose a JPG, PNG or WEBP completion photo up to 5 MB.'); }
      else photo = file || null;
      preview(); update();
    });
    document.getElementById('materialsModal').addEventListener('hidden.bs.modal', () => { if (!saving) { revision++; photo = null; preview(); } });
  }
  window.TechnicianRepairCompletion = { async open(bookingId, options = {}) {
    init(); if (saving) return;
    target = bookingId; onCompleted = options.onCompleted; ready = false; photo = null; preview();
    el('Photo').value = ''; el('Notes').value = ''; el('ConsumablesList').innerHTML = ''; el('Error').hidden = true;
    el('Details').hidden = true; update();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('materialsModal')).show();
    await load();
  } };
})();
