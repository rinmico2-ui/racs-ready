(() => {
  'use strict';

  const root = document.getElementById('unitStaffRequests');
  const detail = document.getElementById('unitStaffDetail');
  if (!root || !detail) return;

  const search = document.getElementById('unitStaffSearch');
  const filter = document.getElementById('unitStaffFilter');
  const errorBox = document.getElementById('unitStaffMessage');
  const noticeBox = document.getElementById('unitStaffNotice');
  const refreshButton = document.getElementById('unitStaffRefresh');
  const appointmentsUrl = document.querySelector('.ua-page')?.dataset.appointmentsUrl || '/admin/appointments';
  const state = { requests: [], selectedId: null, editingQuote: false, loading: false };
  const pesos = amount => `₱${Number(amount || 0).toLocaleString('en-PH')}`;
  const dateLabel = value => value && !Number.isNaN(new Date(value).getTime())
    ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : '—';
  const text = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = String(value);
    return node;
  };
  const icon = className => text('i', `bi ${className}`);
  const append = (parent, ...children) => { parent.append(...children.filter(Boolean)); return parent; };
  const button = (label, className = 'ua-button ua-button-light') => {
    const node = text('button', className, label);
    node.type = 'button';
    return node;
  };
  const field = (label, control, help) => {
    const wrap = text('label', 'ua-field');
    wrap.append(text('span', '', label), control);
    if (help) wrap.append(text('small', '', help));
    return wrap;
  };
  const option = (value, label) => {
    const node = text('option', '', label);
    node.value = value;
    return node;
  };
  const customerName = request => {
    const customer = request.customerId || {};
    return [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.email || 'Customer unavailable';
  };
  const quoteExpired = request => request.quote?.expiresAt && new Date(request.quote.expiresAt) <= new Date();
  const canRenewAccepted = request => request.status === 'accepted' && !request.existingBookingId && !request.bookingId && quoteExpired(request);
  const expired = request => request.status === 'quoted' && quoteExpired(request);
  const needsAction = request => request.status === 'pending' || expired(request) || canRenewAccepted(request) || (request.status === 'accepted' && Boolean(request.existingBookingId));

  function feedback(box, value) {
    box.textContent = value || '';
    box.hidden = !value;
    if (value) box.scrollIntoView({ block: 'nearest' });
  }
  function showSuccess(title, message) {
    const mark = text('span', 'ua-notice-icon');
    mark.append(icon('bi-check-lg'));
    mark.setAttribute('aria-hidden', 'true');
    const copy = text('div', 'ua-notice-copy');
    copy.append(text('strong', '', title), text('span', '', message));
    const dismiss = button('', 'ua-notice-close');
    dismiss.setAttribute('aria-label', 'Dismiss success message');
    dismiss.append(icon('bi-x-lg'));
    dismiss.addEventListener('click', () => { noticeBox.hidden = true; });
    noticeBox.hidden = false;
    noticeBox.replaceChildren(mark, copy, dismiss);
  }
  function statusPill(request) {
    const status = expired(request) || canRenewAccepted(request) ? 'expired' : request.status;
    const names = { pending: 'Needs verification', quoted: 'Waiting for customer', accepted: 'Accepted', expired: 'Quote expired' };
    return text('span', `ua-pill ua-pill-${status}`, names[status] || status);
  }
  function data(label, value, href) {
    const item = text('div', 'ua-data');
    item.append(text('span', '', label));
    if (href) {
      const link = text('a', '', value);
      link.href = href;
      item.append(link);
    } else item.append(text('strong', '', value || 'Not provided'));
    return item;
  }
  function section(title, iconName) {
    const item = text('section', 'ua-section');
    item.append(append(text('h3'), icon(iconName), document.createTextNode(title)));
    return item;
  }
  function guidance(value, warm = false) {
    const item = text('div', warm ? 'ua-guidance ua-guidance-warm' : 'ua-guidance');
    return append(item, icon(warm ? 'bi-exclamation-circle' : 'bi-info-circle'), text('span', '', value));
  }
  function visibleRequests() {
    const query = search.value.trim().toLocaleLowerCase();
    return state.requests.filter(request => {
      const matchesFilter = filter.value === 'all' || (filter.value === 'action' ? needsAction(request) : request.status === filter.value);
      const customer = request.customerId || {};
      const haystack = [request.serviceName, request.existingBookingReference, request.brand, customer.firstName, customer.lastName, customer.email, customer.phone, customer.mobile]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      return matchesFilter && (!query || haystack.includes(query));
    });
  }
  function sortRequests(requests) {
    const rank = request => request.status === 'pending' ? 0 : request.status === 'accepted' && request.existingBookingId ? 1 : expired(request) || canRenewAccepted(request) ? 2 : request.status === 'quoted' ? 3 : 4;
    return requests.sort((a, b) => rank(a) - rank(b) || new Date(b.createdAt) - new Date(a.createdAt));
  }
  function renderList() {
    const requests = sortRequests(visibleRequests());
    document.getElementById('uaResultCount').textContent = `${requests.length} of ${state.requests.length} open requests`;
    document.getElementById('uaPendingCount').textContent = state.requests.filter(request => request.status === 'pending').length;
    document.getElementById('uaQuotedCount').textContent = state.requests.filter(request => request.status === 'quoted').length;
    document.getElementById('uaAcceptedCount').textContent = state.requests.filter(request => request.status === 'accepted').length;
    root.replaceChildren();
    if (!requests.length) {
      root.append(text('div', 'ua-empty', state.requests.length ? 'No requests match this search or filter.' : 'No open identification requests right now.'));
      renderDetail(null);
      return;
    }
    if (!requests.some(request => String(request._id) === state.selectedId)) {
      state.selectedId = String(requests[0]._id);
      state.editingQuote = false;
    }
    for (const request of requests) {
      const item = button('', 'ua-list-item');
      item.setAttribute('aria-current', String(request._id) === state.selectedId ? 'true' : 'false');
      item.setAttribute('aria-label', `${customerName(request)}, ${request.serviceName}, ${statusPill(request).textContent}`);
      const top = append(text('div', 'ua-list-top'), text('strong', '', customerName(request)), statusPill(request));
      const meta = append(text('div', 'ua-list-meta'), text('span', '', `${request.quantity} ${request.quantity === 1 ? 'unit' : 'units'}`), text('span', '', dateLabel(request.createdAt)));
      item.append(top, text('span', 'ua-list-service', request.serviceName), meta);
      item.addEventListener('click', () => {
        state.selectedId = String(request._id);
        state.editingQuote = false;
        renderList();
        renderDetail(request);
        if (window.innerWidth <= 760) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      root.append(item);
    }
    renderDetail(state.requests.find(request => String(request._id) === state.selectedId));
  }
  function renderDetail(request) {
    detail.replaceChildren();
    if (!request) {
      const empty = text('div', 'ua-empty ua-empty-detail');
      append(empty, icon('bi-card-checklist'), text('h2', '', 'Select a request'), text('p', '', 'Customer details, verification, and the next action appear here.'));
      detail.append(empty);
      return;
    }
    const header = text('div', 'ua-detail-header');
    append(header,
      append(text('div', 'ua-detail-overline'), text('span', '', request.existingBookingId ? 'Existing booking change' : 'New service request'), statusPill(request)),
      text('h2', '', request.serviceName),
      text('p', 'ua-detail-sub', `Requested by ${customerName(request)} · ${dateLabel(request.createdAt)}`));
    const body = text('div', 'ua-detail-body');
    const customer = request.customerId || {};
    const customerSection = section('Customer and request', 'bi-person');
    const details = text('div', 'ua-data-grid');
    const phone = customer.phone || customer.mobile;
    details.append(data('Customer', customerName(request)),
      data('Email', customer.email, customer.email ? `mailto:${customer.email}` : null),
      data('Phone', phone, phone && /^[+\d\s()-]+$/.test(phone) ? `tel:${phone.replace(/[^+\d]/g, '')}` : null),
      data('Service quantity', `${request.quantity} ${request.quantity === 1 ? 'unit' : 'units'}`),
      data('Customer reported brand', request.brand || 'Not sure'),
      data('Customer reported type / HP', `${request.airconType || 'Not sure'} / ${request.hp ? `${request.hp} HP` : 'Not sure'}`));
    if (request.relocation?.scope === 'same_property') {
      details.append(data('From · current position', request.relocation.fromPosition || 'Not provided'),
        data('To · new position', request.relocation.toPosition || 'Not provided'));
    }
    if (request.existingBookingId) details.append(data('Existing booking', request.existingBookingReference || String(request.existingBookingId)));
    customerSection.append(details);
    if (request.notes) customerSection.append(text('p', 'ua-customer-note', request.notes));
    body.append(customerSection);

    if (request.quote) body.append(renderQuoteSummary(request));
    if (request.status === 'pending' || ((request.status === 'quoted' || canRenewAccepted(request)) && state.editingQuote)) {
      body.append(renderQuoteForm(request));
    } else if (request.status === 'quoted') {
      body.append(guidance(expired(request)
        ? 'The quote has expired. Verify the details and send an updated quote if the customer still wants this service.'
        : 'The customer has been notified. Wait for them to accept or decline the quote; no appointment is reserved yet.', expired(request)));
      if (request.serviceId?.active !== false && request.serviceId) {
        const revise = button(expired(request) ? 'Renew quote' : 'Revise quote');
        revise.addEventListener('click', () => { state.editingQuote = true; renderDetail(request); detail.querySelector('.ua-form input')?.focus(); });
        body.append(revise);
      }
    } else if (request.status === 'accepted' && request.existingBookingId) {
      body.append(renderResolution(request));
    } else if (canRenewAccepted(request)) {
      body.append(guidance('The customer accepted this quote, but it expired before they booked. Verify the details and send a renewed quote for approval.', true));
      const renew = button('Renew expired quote');
      renew.addEventListener('click', () => { state.editingQuote = true; renderDetail(request); detail.querySelector('.ua-form input')?.focus(); });
      body.append(renew);
    } else if (request.status === 'accepted') {
      body.append(guidance('The customer accepted this price. They must continue booking on the Services page to choose a schedule and complete payment. This request will close when that booking is submitted.'));
    }
    detail.append(header, body);
  }
  function renderQuoteSummary(request) {
    const quote = request.quote;
    const block = section('Quote sent to customer', 'bi-receipt');
    const grid = text('div', 'ua-data-grid');
    grid.append(data('Identified unit', `${quote.brand || 'Brand unknown'} · ${quote.airconTypeName || quote.airconType || 'Aircon'} · ${quote.hp} HP`),
      data('Catalog price', `${pesos(quote.unitPrice)} per unit`),
      data('Service total', `${pesos(Number(quote.unitPrice) * Number(request.quantity))} before travel fare`),
      data('Verified by', ({ customer_contact:'Customer contact', model_label:'Model label', site_visit:'Site visit' })[quote.verificationMethod] || 'Not recorded'),
      data('Sent', dateLabel(quote.quotedAt)), data('Valid until', dateLabel(quote.expiresAt)));
    block.append(grid);
    if (quote.notes) block.append(text('p', 'ua-customer-note', quote.notes));
    return block;
  }
  function renderQuoteForm(request) {
    const catalog = request.serviceId;
    const block = section(canRenewAccepted(request) ? 'Renew verified quote' : request.status === 'quoted' ? 'Update verified details' : 'Verify and price this unit', 'bi-patch-check');
    if (!catalog || catalog.active === false) {
      block.append(guidance('This service is no longer active in the catalog. A price cannot be sent until the service is available again.', true));
      return block;
    }
    block.append(guidance('Confirm the details with the customer, model label, or a site visit. The price below comes from the active service catalog.'));
    const form = text('form', 'ua-form');
    const grid = text('div', 'ua-form-grid');
    const brand = text('input'); brand.type = 'text'; brand.maxLength = 80; brand.required = true;
    brand.value = request.quote?.brand || (request.brand?.toLowerCase() === "i don't know" ? "I don't know" : request.brand || '');
    brand.placeholder = "Brand or I don't know";
    const type = text('select');
    type.required = Boolean(catalog.airconTypes?.length);
    type.append(option('', 'Choose aircon type'));
    for (const item of catalog.airconTypes || []) type.append(option(item.type, item.name));
    type.value = request.quote?.airconType || request.airconType || '';
    const hp = text('select'); hp.required = true;
    const verification = text('select'); verification.required = true;
    verification.append(option('', 'Choose how you verified'), option('customer_contact', 'Confirmed with customer'), option('model_label', 'Checked model label'), option('site_visit', 'Checked during site visit'));
    verification.value = request.quote?.verificationMethod || '';
    grid.append(field('Brand', brand, "Use “I don't know” only if brand could not be confirmed."),
      field('Aircon type', type), field('HP', hp), field('Verification method', verification));
    form.append(grid);
    const preview = text('div', 'ua-price-preview');
    const price = text('strong', '', 'Choose type and HP');
    preview.append(text('span', '', `Catalog price for ${request.quantity} ${request.quantity === 1 ? 'unit' : 'units'}`), price,
      text('small', '', 'Before travel fare. Customer approval is required; no slot is reserved.'));
    form.append(preview);
    const notes = text('textarea'); notes.maxLength = 1000; notes.rows = 3; notes.value = request.quote?.notes || '';
    notes.placeholder = 'Optional explanation the customer will see with the quote';
    form.append(field('Notes to customer', notes));
    const actions = text('div', 'ua-form-actions');
    const submit = text('button', 'ua-button ua-button-primary', canRenewAccepted(request) ? 'Send renewed quote' : request.status === 'quoted' ? 'Send updated quote' : 'Send quote for approval');
    submit.type = 'submit';
    actions.append(submit, text('small', '', 'Quote is valid for 7 days.'));
    if (request.status !== 'pending') {
      const cancel = button('Cancel edit');
      cancel.addEventListener('click', () => { state.editingQuote = false; renderDetail(request); });
      actions.append(cancel);
    }
    form.append(actions);
    const tiers = () => {
      const selected = (catalog.airconTypes || []).find(item => item.type === type.value);
      return selected?.hpPricing || (catalog.airconTypes?.length ? [] : catalog.hpPricing || []);
    };
    const updatePreview = () => {
      const tier = tiers().find(item => String(item.hp) === hp.value);
      price.textContent = tier ? `${pesos(Number(tier.price) * Number(request.quantity))} total · ${pesos(tier.price)} per unit` : 'Choose type and HP';
      submit.disabled = !brand.value.trim() || !verification.value || !tier || (type.required && !type.value);
    };
    const updateTiers = preferredHp => {
      hp.replaceChildren(option('', 'Choose HP'));
      for (const tier of tiers()) hp.append(option(String(tier.hp), `${tier.hp} HP · ${pesos(tier.price)} per unit`));
      if (tiers().some(tier => String(tier.hp) === String(preferredHp))) hp.value = String(preferredHp);
      updatePreview();
    };
    type.addEventListener('change', () => updateTiers(''));
    hp.addEventListener('change', updatePreview);
    brand.addEventListener('input', updatePreview);
    verification.addEventListener('change', updatePreview);
    updateTiers(request.quote?.hp || request.hp || '');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity() || submit.disabled) return;
      submit.disabled = true;
      feedback(errorBox, '');
      const successTitle = canRenewAccepted(request) ? 'Renewed quote sent' : request.status === 'quoted' ? 'Quote updated successfully' : 'Quote sent successfully';
      try {
        const result = await fetchJson(`/api/unit-assistance/staff/${encodeURIComponent(request._id)}/quote`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand: brand.value.trim(), airconType: type.value, hp: hp.value, notes: notes.value.trim(), verificationMethod: verification.value,
            expectedQuotedAt: request.quote?.quotedAt || null }),
        });
        state.selectedId = String(result.request._id);
        state.editingQuote = false;
        await load();
        showSuccess(successTitle, 'The customer can review the verified unit and price. Next: wait for their approval.');
      } catch (error) {
        feedback(errorBox, error.message);
        updatePreview();
      }
    });
    block.append(form);
    return block;
  }
  function renderResolution(request) {
    const block = section('Existing booking follow-up', 'bi-clipboard-check');
    block.append(guidance('The customer accepted the price for an existing booking. Update that booking and any payment adjustment in Appointments first. Mark this request handled only after the change is complete.', true));
    const appointment = text('a', 'ua-button ua-button-light', 'Open appointments');
    appointment.href = appointmentsUrl;
    block.append(appointment);
    const form = text('form', 'ua-form');
    const notes = text('textarea'); notes.required = true; notes.minLength = 10; notes.maxLength = 1000; notes.rows = 3;
    notes.placeholder = 'Record what changed in the booking and how payment was handled';
    const confirm = text('input'); confirm.type = 'checkbox'; confirm.required = true;
    const checkline = text('label', 'ua-checkline');
    checkline.append(confirm, text('span', '', 'I updated the booking and handled any payment adjustment.'));
    const submit = text('button', 'ua-button ua-button-primary', 'Mark follow-up handled'); submit.type = 'submit';
    form.append(field('Completion notes', notes, 'At least 10 characters. This becomes part of the request record.'), checkline, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      submit.disabled = true;
      feedback(errorBox, '');
      try {
        await fetchJson(`/api/unit-assistance/staff/${encodeURIComponent(request._id)}/resolve`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed: confirm.checked, notes: notes.value.trim() }),
        });
        state.selectedId = null;
        await load();
        showSuccess('Follow-up marked handled', 'The request is complete and no longer needs action in this queue.');
      } catch (error) { feedback(errorBox, error.message); submit.disabled = false; }
    });
    block.append(form);
    return block;
  }
  async function fetchJson(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not complete this action. Please try again.');
    return payload;
  }
  async function load() {
    if (state.loading) return;
    state.loading = true;
    refreshButton.disabled = true;
    try {
      const payload = await fetchJson('/api/unit-assistance/staff');
      state.requests = Array.isArray(payload.requests) ? payload.requests : [];
      feedback(errorBox, '');
      renderList();
    } catch (error) {
      feedback(errorBox, error.message);
      if (!state.requests.length) {
        root.replaceChildren(text('div', 'ua-empty', 'The queue could not load. Use Refresh queue to try again.'));
        renderDetail(null);
      }
    } finally {
      state.loading = false;
      refreshButton.disabled = false;
    }
  }
  refreshButton.addEventListener('click', load);
  search.addEventListener('input', renderList);
  filter.addEventListener('change', () => { state.selectedId = null; state.editingQuote = false; renderList(); });
  load();
})();
