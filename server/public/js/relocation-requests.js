(() => {
  'use strict';
  const list = document.getElementById('relocationList');
  const message = document.getElementById('relocationMessage');
  const isStaff = document.querySelector('.rr-page')?.classList.contains('rr-staff');
  let requests = [];
  let loadSequence = 0;
  let customerReady = false;
  const money = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const date = value => value ? new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const label = status => ({ pending_review: 'Needs review', assessment_needed: 'Assessment needed', quoted: 'Waiting for your decision', accepted: 'Quote accepted', declined: 'Declined', converted: 'Booking submitted', completed: 'Completed', cancelled: 'Cancelled' })[status] || status;
  const show = (text, error = false) => { delete message.dataset.loadError; message.textContent = text; message.hidden = false; message.classList.toggle('is-error', error); message.scrollIntoView({ block: 'nearest' }); };
  async function api(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not complete that action.');
    return data;
  }
  function quoteMarkup(request) {
    if (!request.quote?.total) return '';
    const rows = (request.quote.lines || []).map(line => `<div class="rr-quote-row"><span>${esc(line.label)}</span><strong>${money(line.amount)}</strong></div>`).join('');
    if (!isStaff) return `<aside class="rr-quote" aria-label="Relocation quote"><span class="rr-quote-title">Your relocation quote</span><strong class="rr-quote-price">${money(request.quote.total)}</strong><p class="rr-details">${request.quote.expiresAt ? `Valid until ${date(request.quote.expiresAt)}` : 'Review the price before you continue.'}</p><details class="rr-quote-breakdown"><summary>View price breakdown<i class="bi bi-chevron-down" aria-hidden="true"></i></summary>${rows}<div class="rr-quote-total"><span>Total</span><span>${money(request.quote.total)}</span></div><p class="rr-details">Estimated work: ${esc(request.quote.durationMinutes || '\u2014')} minutes &middot; Quote version ${Number(request.quote.version || 0)}${request.quote.notes ? `<br>${esc(request.quote.notes)}` : ''}</p></details></aside>`;
    const content = `<div class="rr-quote"><p class="rr-quote-title">Itemized quote · version ${Number(request.quote.version || 0)}</p>${rows}<div class="rr-quote-total"><span>Total</span><span>${money(request.quote.total)}</span></div><p class="rr-details">Estimated work: ${esc(request.quote.durationMinutes || '—')} minutes${request.quote.expiresAt ? ` · Valid until ${date(request.quote.expiresAt)}` : ''}${request.quote.notes ? ` · ${esc(request.quote.notes)}` : ''}</p></div>`;
    return isStaff ? `<details class="rr-sent-quote"><summary><span>Current quote · ${money(request.quote.total)}</span></summary>${content}</details>` : content;
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
    return `<details class="rr-editor"><summary><span>${request.quote?.version ? 'Review and revise quote' : 'Prepare quote / request site check'}</span></summary><form class="rr-staff-form" data-id="${request._id}" data-version="${Number(request.quote?.version || 0)}">
      <div class="rr-fields">
        <div class="rr-field"><label for="brand-${request._id}">Verified brand</label><input id="brand-${request._id}" name="brand" maxlength="80" value="${esc(request.unit?.brand || '')}" required></div>
        <div class="rr-field"><label for="type-${request._id}">Aircon type</label><select id="type-${request._id}" name="airconType" required>${typeOptions.map(([value, text]) => `<option value="${value}" ${request.unit?.airconType === value ? 'selected' : ''}>${text}</option>`).join('')}</select></div>
        <div class="rr-field"><label for="hp-${request._id}">HP</label><input id="hp-${request._id}" name="hp" type="number" min="0.1" max="20" step="0.1" value="${esc(request.unit?.hp || '')}" required></div>
        <div class="rr-field"><label for="duration-${request._id}">Estimated technician time (minutes)</label><input id="duration-${request._id}" name="durationMinutes" type="number" min="60" max="1440" step="30" value="${esc(request.quote?.durationMinutes || 240)}" required></div>
        <div class="rr-field"><label for="assessment-${request._id}">Assessment note</label><input id="assessment-${request._id}" name="assessment" maxlength="1000" value="${esc(request.assessmentNotes || '')}" placeholder="Why a site check is needed"></div>
      </div>
      <p class="rr-quote-title" style="margin-top:15px">Quote items</p><p class="rr-details">Include any transport, travel, piping, and materials here. Checkout will use this approved total without adding an automatic travel fare.</p>
      <div class="rr-lines">${defaultLines.map(line => `<div class="rr-line-grid"><div class="rr-field"><label>Cost item</label><input name="lineLabel" maxlength="100" value="${esc(line.label)}" placeholder="e.g. Transport"></div><div class="rr-field"><label>Amount (₱)</label><input name="lineAmount" type="number" min="0" max="1000000" step="0.01" value="${esc(line.amount)}" placeholder="0.00"></div></div>`).join('')}</div>
      <div class="rr-live-total"><span>Quote total</span><strong data-quote-total>${money(defaultLines.reduce((total, line) => total + (Number(line.amount) || 0), 0))}</strong></div>
      <div class="rr-field rr-field-wide"><label for="quote-notes-${request._id}">Quote notes</label><textarea id="quote-notes-${request._id}" name="notes" rows="2" maxlength="1000" placeholder="Materials, access, exclusions, or timing">${esc(request.quote?.notes || '')}</textarea></div>
      <div class="rr-actions"><button class="rr-button rr-button-light" type="button" data-add-line="${request._id}">Add cost item</button>${['pending_review', 'assessment_needed'].includes(request.status) ? `<button class="rr-button rr-button-light" type="button" data-action="assessment" data-id="${request._id}">Request site check</button>` : ''}<button class="rr-button" type="submit">${request.quote?.version ? 'Send revised quote' : 'Send quote'}</button></div>
    </form></details>`;
  }

  function staffCard(request) {
    const person = request.customerId && typeof request.customerId === 'object' ? request.customerId : {};
    const name = `${person.firstName || ''} ${person.lastName || ''}`.trim() || person.email || 'Customer';
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    const type = typeOptions.find(([value]) => value === request.unit?.airconType)?.[1] || 'Type to check';
    const expired = ['quoted', 'accepted'].includes(request.status) && request.quote?.expiresAt && new Date(request.quote.expiresAt) <= new Date() && !request.bookingId;
    const statusText = expired ? 'Quote expired' : ({ quoted: 'Quote sent', assessment_needed: 'Site check needed' })[request.status] || label(request.status);
    const phone = person.phone || person.mobile || '';
    return `<article class="rr-card" data-request-id="${esc(request._id)}">
      <div class="rr-card-head"><div class="rr-person"><span class="rr-avatar" aria-hidden="true">${esc(initials)}</span><div><h3>${esc(name)}</h3><div class="rr-request-meta"><span class="rr-request-id">Request #${esc(String(request._id).slice(-8).toUpperCase())}</span><span>Requested ${date(request.createdAt)}</span><span>Preferred ${date(request.preferredDate)}</span></div></div></div><span class="rr-badge is-${expired ? 'expired' : esc(request.status)}">${esc(statusText)}</span></div>
      <div class="rr-card-content">
        <div class="rr-route"><div class="rr-location"><span><i class="bi bi-geo-alt" aria-hidden="true"></i>Current location</span><strong>${esc(request.from?.address || 'Location not provided')}</strong>${request.from?.details ? `<small>${esc(request.from.details)}</small>` : ''}</div><div class="rr-location is-destination"><span><i class="bi bi-pin-map" aria-hidden="true"></i>New location</span><strong>${esc(request.to?.address || 'Location not provided')}</strong>${request.to?.details ? `<small>${esc(request.to.details)}</small>` : ''}</div></div>
        <div class="rr-unit-row"><span class="rr-unit-label">Aircon</span><span class="rr-unit-tag">${esc(request.unit?.brand || 'Brand to check')}</span><span class="rr-unit-tag">${esc(type)}</span><span class="rr-unit-tag">${request.unit?.hp ? `${esc(request.unit.hp)} HP` : 'HP to check'}</span>${request.unit?.model ? `<span class="rr-unit-tag">${esc(request.unit.model)}</span>` : ''}${request.unit?.serialNumber ? `<span class="rr-unit-tag">Serial ${esc(request.unit.serialNumber)}</span>` : ''}</div>
        ${request.notes ? `<p class="rr-details"><strong>Customer note:</strong> ${esc(request.notes)}</p>` : ''}${request.assessmentNotes ? `<p class="rr-details"><strong>Site check:</strong> ${esc(request.assessmentNotes)}</p>` : ''}
        ${person.email || phone ? `<div class="rr-contact-row">${person.email ? `<a href="mailto:${esc(encodeURIComponent(person.email))}"><i class="bi bi-envelope" aria-hidden="true"></i>${esc(person.email)}</a>` : ''}${phone ? `<a href="tel:${esc(phone.replace(/[^+\d]/g, ''))}"><i class="bi bi-telephone" aria-hidden="true"></i>${esc(phone)}</a>` : ''}</div>` : ''}
        ${quoteMarkup(request)}${staffActions(request)}
      </div>
    </article>`;
  }

  function applyStaffFilters() {
    if (!isStaff || list.getAttribute('aria-busy') === 'true') return;
    const search = document.getElementById('relocationSearch').value.trim().toLowerCase();
    const status = document.getElementById('relocationStatus').value;
    const sort = document.getElementById('relocationSort').value;
    const nodes = new Map([...list.querySelectorAll('[data-request-id]')].map(node => [node.dataset.requestId, node]));
    const timestamp = (value, fallback = 0) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : fallback;
    const sorted = [...requests].sort((a, b) => sort === 'preferred'
      ? timestamp(a.preferredDate, Number.MAX_SAFE_INTEGER) - timestamp(b.preferredDate, Number.MAX_SAFE_INTEGER)
      : (timestamp(a.createdAt) - timestamp(b.createdAt)) * (sort === 'oldest' ? 1 : -1));
    let visible = 0;
    const fragment = document.createDocumentFragment();
    for (const request of sorted) {
      const node = nodes.get(String(request._id));
      if (!node) continue;
      const person = request.customerId || {};
      const haystack = [request._id, person.firstName, person.lastName, person.email, person.phone, person.mobile, request.from?.address, request.to?.address, request.unit?.brand, request.unit?.airconType, request.unit?.model, request.unit?.serialNumber, request.notes].join(' ').toLowerCase();
      node.hidden = Boolean(status && request.status !== status || search && !haystack.includes(search));
      if (!node.hidden) visible++;
      fragment.append(node);
    }
    // Move existing cards so filtering/sorting preserves unsent quote fields.
    list.append(fragment);
    document.getElementById('relocationResultCount').textContent = `${visible} of ${requests.length} loaded request${requests.length === 1 ? '' : 's'}`;
    document.getElementById('relocationFilteredEmpty').hidden = visible > 0 || requests.length === 0;
  }

  function updateStaffCounts() {
    const counts = { relocationReviewCount: ['pending_review', 'assessment_needed'], relocationQuotedCount: ['quoted'], relocationAcceptedCount: ['accepted'], relocationBookedCount: ['converted'] };
    for (const [id, statuses] of Object.entries(counts)) document.getElementById(id).textContent = String(requests.filter(request => statuses.includes(request.status)).length);
  }

  function card(request) {
    if (isStaff) return staffCard(request);
    const type = typeOptions.find(([value]) => value === request.unit?.airconType)?.[1] || 'Type to check';
    const unit = [request.unit?.brand || 'Brand to check', type, request.unit?.hp ? `${request.unit.hp} HP` : 'HP to check'].join(' \u00b7 ');
    const details = [request.unit?.model ? `Model: ${request.unit.model}` : '', request.unit?.serialNumber ? `Serial: ${request.unit.serialNumber}` : ''].filter(Boolean).join(' \u00b7 ');
    const actions = customerActions(request);
    return `<article class="rr-card${request.quote?.total ? ' rr-card-with-quote' : ''}" data-request-id="${esc(request._id)}" data-request-status="${esc(request.status)}">
      <div class="rr-card-head"><div><span class="rr-request-id">REQUEST #${esc(String(request._id).slice(-8).toUpperCase())}</span><h3>Aircon relocation</h3><small>Requested ${date(request.createdAt)} &middot; Preferred ${date(request.preferredDate)}</small></div><span class="rr-badge is-${esc(request.status)}">${esc(label(request.status))}</span></div>
      <div class="rr-card-body">
        <div class="rr-move-details">
        <div class="rr-route"><div class="rr-location"><span>Current location</span><strong>${esc(request.from?.address || 'Address not provided')}</strong>${request.from?.details ? `<small>${esc(request.from.details)}</small>` : ''}</div><div class="rr-location"><span>New location</span><strong>${esc(request.to?.address || 'Address not provided')}</strong>${request.to?.details ? `<small>${esc(request.to.details)}</small>` : ''}</div></div>
        <div class="rr-unit-summary"><i class="bi bi-snow2" aria-hidden="true"></i><div><strong>${esc(unit)}</strong>${details ? `<small>${esc(details)}</small>` : ''}</div></div>
        ${request.notes ? `<p class="rr-details"><strong>Your note:</strong> ${esc(request.notes)}</p>` : ''}
        ${request.assessmentNotes ? `<p class="rr-details"><strong>Staff note:</strong> ${esc(request.assessmentNotes)}</p>` : ''}
        </div>${quoteMarkup(request)}
      </div>
      ${actions ? `<footer class="rr-card-footer">${actions}</footer>` : ['pending_review', 'assessment_needed'].includes(request.status) ? `<footer class="rr-card-footer rr-next-step"><i class="bi bi-clock" aria-hidden="true"></i><span>${request.status === 'assessment_needed' ? 'Staff will contact you about a site check.' : 'Staff will review your request and send the next step.'}</span></footer>` : ''}
    </article>`;
  }
  function applyCustomerFilters() {
    const search = document.getElementById('relocationCustomerSearch');
    if (isStaff || !search || !customerReady) return;
    const query = search.value.trim().toLowerCase();
    const status = document.getElementById('relocationCustomerStatus').value;
    let visible = 0;
    for (const card of list.querySelectorAll('[data-request-id]')) {
      card.hidden = Boolean(status && card.dataset.requestStatus !== status || query && !card.textContent.toLowerCase().includes(query));
      if (!card.hidden) visible++;
    }
    document.getElementById('relocationCustomerCount').textContent = `${visible} of ${requests.length} request${requests.length === 1 ? '' : 's'}`;
    document.getElementById('relocationCustomerFilteredEmpty').hidden = visible > 0 || requests.length === 0;
  }
  async function load() {
    const sequence = ++loadSequence;
    customerReady = false;
    const customerCount = document.getElementById('relocationCustomerCount');
    if (!isStaff && customerCount) customerCount.textContent = 'Loading requests...';
    if (message.dataset.loadError === 'true') { message.hidden = true; delete message.dataset.loadError; }
    list.setAttribute('aria-busy', 'true');
    const refresh = document.getElementById('relocationRefresh');
    if (refresh) refresh.disabled = true;
    if (isStaff) document.getElementById('relocationFilteredEmpty').hidden = true;
    else if (document.getElementById('relocationCustomerFilteredEmpty')) document.getElementById('relocationCustomerFilteredEmpty').hidden = true;
    list.innerHTML = '<div class="rr-loading" role="status"><span class="rr-loading-spinner" aria-hidden="true"></span>Loading requests…</div>';
    try {
      const data = await api(`/api/relocations/${isStaff ? 'staff' : 'mine'}`);
      if (sequence !== loadSequence) return;
      requests = data.requests || [];
      customerReady = true;
      list.innerHTML = requests.length ? requests.map(card).join('') : isStaff
        ? '<div class="rr-empty"><i class="bi bi-inbox" aria-hidden="true"></i><strong>No relocation requests yet</strong><p>New customer requests will appear here for review.</p></div>'
        : '<div class="rr-empty"><i class="bi bi-geo-alt" aria-hidden="true"></i><strong>No relocation requests yet</strong><p>Choose Aircon Relocation from Services to request a move.</p><a class="rr-button" href="/services">Browse services</a></div>';
      list.setAttribute('aria-busy', 'false');
      if (isStaff) { updateStaffCounts(); applyStaffFilters(); }
      else applyCustomerFilters();
    } catch (error) {
      if (sequence !== loadSequence) return;
      list.innerHTML = '<div class="rr-empty"><strong>Requests could not load</strong><p>Please try again.</p><button class="rr-button rr-button-light" type="button" data-retry-load>Retry</button></div>';
      if (isStaff) {
        document.getElementById('relocationResultCount').textContent = 'Requests unavailable';
        for (const id of ['relocationReviewCount', 'relocationQuotedCount', 'relocationAcceptedCount', 'relocationBookedCount']) document.getElementById(id).textContent = '—';
      }
      if (!isStaff && document.getElementById('relocationCustomerCount')) document.getElementById('relocationCustomerCount').textContent = 'Requests unavailable';
      show(error.message, true);
      message.dataset.loadError = 'true';
    } finally {
      if (sequence === loadSequence) { list.setAttribute('aria-busy', 'false'); if (refresh) refresh.disabled = false; }
    }
  }
  document.getElementById('relocationRefresh')?.addEventListener('click', load);
  if (!isStaff) {
    document.getElementById('relocationCustomerSearch')?.addEventListener('input', applyCustomerFilters);
    document.getElementById('relocationCustomerStatus')?.addEventListener('change', applyCustomerFilters);
    document.getElementById('relocationCustomerClear')?.addEventListener('click', () => { document.getElementById('relocationCustomerSearch').value = ''; document.getElementById('relocationCustomerStatus').value = ''; applyCustomerFilters(); });
  }
  if (isStaff) {
    document.getElementById('relocationSearch').addEventListener('input', applyStaffFilters);
    for (const id of ['relocationStatus', 'relocationSort']) document.getElementById(id).addEventListener('change', applyStaffFilters);
    const clear = () => { document.getElementById('relocationSearch').value = ''; document.getElementById('relocationStatus').value = ''; document.getElementById('relocationSort').value = 'newest'; applyStaffFilters(); };
    document.getElementById('relocationClear').addEventListener('click', clear);
    document.getElementById('relocationResetFilters').addEventListener('click', clear);
    list.addEventListener('input', event => {
      if (!event.target.matches('[name="lineAmount"]')) return;
      const form = event.target.closest('form');
      const cents = [...form.querySelectorAll('[name="lineAmount"]')].reduce((total, input) => total + Math.round(Math.max(0, Number(input.value) || 0) * 100), 0);
      form.querySelector('[data-quote-total]').textContent = money(cents / 100);
    });
  }
  list.addEventListener('click', async event => {
    if (event.target.closest('[data-retry-load]')) { load(); return; }
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
