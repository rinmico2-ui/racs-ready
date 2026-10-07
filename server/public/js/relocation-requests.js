(() => {
  'use strict';
  const list = document.getElementById('relocationList');
  const message = document.getElementById('relocationMessage');
  const isStaff = document.querySelector('.rr-page')?.classList.contains('rr-staff');
  const money = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const date = value => value ? new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const label = status => ({ pending_review: 'Needs review', assessment_needed: 'Assessment needed', quoted: 'Waiting for your decision', accepted: 'Quote accepted', declined: 'Declined', converted: 'Booking submitted', completed: 'Completed', cancelled: 'Cancelled' })[status] || status;
  const show = (text, error = false) => { message.textContent = text; message.hidden = false; message.classList.toggle('is-error', error); message.scrollIntoView({ block: 'nearest' }); };
  async function api(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not complete that action.');
    return data;
  }
  function quoteMarkup(request) {
    if (!request.quote?.total) return '';
    const rows = (request.quote.lines || []).map(line => `<div class="rr-quote-row"><span>${esc(line.label)}</span><strong>${money(line.amount)}</strong></div>`).join('');
    return `<div class="rr-quote"><p class="rr-quote-title">Itemized quote · version ${Number(request.quote.version || 0)}</p>${rows}<div class="rr-quote-total"><span>Total</span><span>${money(request.quote.total)}</span></div><p class="rr-details">Estimated work: ${esc(request.quote.durationMinutes || '—')} minutes${request.quote.expiresAt ? ` · Valid until ${date(request.quote.expiresAt)}` : ''}${request.quote.notes ? ` · ${esc(request.quote.notes)}` : ''}</p></div>`;
  }
  function customerActions(request) {
    if (request.status === 'quoted') {
      if (request.quote?.expiresAt && new Date(request.quote.expiresAt) <= new Date()) return '<p class="rr-details">This quote expired. Staff must send a new quote before you can continue.</p>';
      return `<div class="rr-actions"><button type="button" class="rr-button" data-action="accept" data-id="${request._id}" data-version="${request.quote.version}">Accept quote</button><button type="button" class="rr-button rr-button-light" data-action="decline" data-id="${request._id}" data-version="${request.quote.version}">Decline quote</button></div>`;
    }
    if (request.status === 'accepted') return request.quote?.expiresAt && new Date(request.quote.expiresAt) <= new Date()
      ? '<p class="rr-details">This accepted quote expired before booking. Contact staff for a revised quote.</p>'
      : `<p class="rr-details">Next: choose a schedule and submit your required payment. Staff verifies payment before assigning a technician.</p><div class="rr-actions"><a class="rr-button" href="/services?relocationRequest=${encodeURIComponent(request._id)}">Continue to booking and payment</a></div>`;
    if (request.bookingId) return `<div class="rr-actions"><a class="rr-button rr-button-light" href="/book-history">View booking</a></div>`;
    return '';
  }
  const typeOptions = [['', 'Choose type'], ['split', 'Split'], ['window', 'Window'], ['cassette', 'Cassette'], ['floor_standing', 'Floor standing'], ['floor_mounted', 'Floor mounted'], ['split_suspended', 'Split suspended'], ['central', 'Central']];
  function staffActions(request) {
    const renewal = request.status === 'accepted' && request.quote?.expiresAt && new Date(request.quote.expiresAt) <= new Date() && !request.bookingId;
    if (!['pending_review', 'assessment_needed', 'quoted'].includes(request.status) && !renewal) {
      return `<p class="rr-details">${request.status === 'accepted' ? 'Customer accepted. Waiting for booking and payment submission.' : request.bookingId ? 'Booking submitted. Verify payment in Appointments before assignment.' : 'No staff action needed.'}</p>`;
    }
    const defaultLines = request.quote?.lines?.length ? request.quote.lines : [
      { label: 'Dismantling', amount: '' }, { label: 'Transport', amount: '' },
      { label: 'Reinstallation', amount: '' }, { label: 'Additional piping', amount: '' },
    ];
    return `<form class="rr-staff-form" data-id="${request._id}" data-version="${Number(request.quote?.version || 0)}">
      <div class="rr-fields">
        <div class="rr-field"><label for="brand-${request._id}">Verified brand</label><input id="brand-${request._id}" name="brand" maxlength="80" value="${esc(request.unit?.brand || '')}" required></div>
        <div class="rr-field"><label for="type-${request._id}">Aircon type</label><select id="type-${request._id}" name="airconType" required>${typeOptions.map(([value, text]) => `<option value="${value}" ${request.unit?.airconType === value ? 'selected' : ''}>${text}</option>`).join('')}</select></div>
        <div class="rr-field"><label for="hp-${request._id}">HP</label><input id="hp-${request._id}" name="hp" type="number" min="0.1" max="20" step="0.1" value="${esc(request.unit?.hp || '')}" required></div>
        <div class="rr-field"><label for="duration-${request._id}">Estimated technician time (minutes)</label><input id="duration-${request._id}" name="durationMinutes" type="number" min="60" max="1440" step="30" value="${esc(request.quote?.durationMinutes || 240)}" required></div>
        <div class="rr-field"><label for="assessment-${request._id}">Assessment note</label><input id="assessment-${request._id}" name="assessment" maxlength="1000" value="${esc(request.assessmentNotes || '')}" placeholder="Why a site check is needed"></div>
      </div>
      <p class="rr-quote-title" style="margin-top:15px">Quote items</p><p class="rr-details">Include any transport, travel, piping, and materials here. Checkout will use this approved total without adding an automatic travel fare.</p>
      <div class="rr-lines">${defaultLines.map(line => `<div class="rr-line-grid"><div class="rr-field"><label>Cost item</label><input name="lineLabel" maxlength="100" value="${esc(line.label)}" placeholder="e.g. Transport"></div><div class="rr-field"><label>Amount (₱)</label><input name="lineAmount" type="number" min="0" max="1000000" step="0.01" value="${esc(line.amount)}" placeholder="0.00"></div></div>`).join('')}</div>
      <div class="rr-field rr-field-wide"><label for="quote-notes-${request._id}">Quote notes</label><textarea id="quote-notes-${request._id}" name="notes" rows="2" maxlength="1000" placeholder="Materials, access, exclusions, or timing">${esc(request.quote?.notes || '')}</textarea></div>
      <div class="rr-actions"><button class="rr-button rr-button-light" type="button" data-add-line="${request._id}">Add cost item</button><button class="rr-button rr-button-light" type="button" data-action="assessment" data-id="${request._id}">Request assessment</button><button class="rr-button" type="submit">${request.quote?.version ? 'Send revised quote' : 'Send quote'}</button></div>
    </form>`;
  }
  function card(request) {
    const person = request.customerId && typeof request.customerId === 'object' ? request.customerId : null;
    const customer = person ? `${person.firstName || ''} ${person.lastName || ''}`.trim() || person.email : '';
    return `<article class="rr-card">
      <div class="rr-card-head"><div><h3>${isStaff ? esc(customer || 'Customer') : 'Aircon Relocation'}</h3><small>Requested ${date(request.createdAt)} · Preferred ${date(request.preferredDate)}${isStaff && person?.email ? ` · ${esc(person.email)}` : ''}</small></div><span class="rr-badge is-${esc(request.status)}">${esc(label(request.status))}</span></div>
      <div class="rr-route"><div class="rr-location"><span>From · current location</span><strong>${esc(request.from?.address)}</strong>${request.from?.details ? `<small>${esc(request.from.details)}</small>` : ''}</div><div class="rr-location"><span>To · new location</span><strong>${esc(request.to?.address)}</strong>${request.to?.details ? `<small>${esc(request.to.details)}</small>` : ''}</div></div>
      <div class="rr-details">Unit: ${esc(request.unit?.brand || 'Brand to verify')} · ${esc(request.unit?.airconType || 'Type to verify')} · ${request.unit?.hp ? `${esc(request.unit.hp)} HP` : 'HP to verify'}${request.unit?.model ? ` · Model ${esc(request.unit.model)}` : ''}${request.unit?.serialNumber ? ` · Serial ${esc(request.unit.serialNumber)}` : ''}</div>
      ${request.notes ? `<p class="rr-details">Customer notes: ${esc(request.notes)}</p>` : ''}
      ${request.assessmentNotes ? `<p class="rr-details">Assessment: ${esc(request.assessmentNotes)}</p>` : ''}
      ${quoteMarkup(request)}${isStaff ? staffActions(request) : customerActions(request)}
    </article>`;
  }
  async function load() {
    list.innerHTML = '<p class="rr-muted">Loading requests…</p>';
    try {
      const data = await api(`/api/relocations/${isStaff ? 'staff' : 'mine'}`);
      list.innerHTML = data.requests.length ? data.requests.map(card).join('') : '<div class="rr-empty">No relocation requests yet. Choose Aircon Relocation from Services to get started.</div>';
    } catch (error) { list.innerHTML = ''; show(error.message, true); }
  }
  document.getElementById('relocationRefresh')?.addEventListener('click', load);
  list.addEventListener('click', async event => {
    const addLine = event.target.closest('[data-add-line]');
    if (addLine) {
      const lines = addLine.closest('form')?.querySelector('.rr-lines');
      if (lines && lines.children.length < 20) lines.insertAdjacentHTML('beforeend', '<div class="rr-line-grid"><div class="rr-field"><label>Cost item</label><input name="lineLabel" maxlength="100" placeholder="e.g. Extra piping"></div><div class="rr-field"><label>Amount (₱)</label><input name="lineAmount" type="number" min="0" max="1000000" step="0.01" placeholder="0.00"></div></div>');
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    button.disabled = true;
    try {
      const { action, id, version } = button.dataset;
      if (action === 'assessment') {
        const notes = button.closest('form')?.elements.assessment.value.trim() || '';
        await api(`/api/relocations/staff/${id}/assessment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) });
        show('Assessment request saved. The customer has been notified.');
      } else {
        await api(`/api/relocations/mine/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: action, version: Number(version) }) });
        show(action === 'accept' ? 'Quote accepted. Continue to booking and payment.' : 'Quote declined. Staff has been notified.');
      }
      await load();
    } catch (error) { show(error.message, true); button.disabled = false; }
  });
  list.addEventListener('submit', async event => {
    const form = event.target.closest('.rr-staff-form');
    if (!form) return;
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const labels = [...form.querySelectorAll('[name="lineLabel"]')];
    const amounts = [...form.querySelectorAll('[name="lineAmount"]')];
    const lines = labels.map((input, index) => ({ label: input.value.trim(), amount: amounts[index].value })).filter(line => line.amount !== '');
    submit.disabled = true;
    try {
      await api(`/api/relocations/staff/${form.dataset.id}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        expectedVersion: Number(form.dataset.version), brand: form.elements.brand.value, airconType: form.elements.airconType.value,
        hp: form.elements.hp.value, durationMinutes: form.elements.durationMinutes.value, lines, notes: form.elements.notes.value,
      }) });
      show('Itemized quote sent. The customer can now review it.');
      await load();
    } catch (error) { show(error.message, true); submit.disabled = false; }
  });
  load();
})();
