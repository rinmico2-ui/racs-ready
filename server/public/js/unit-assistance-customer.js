(() => {
  'use strict';

  const root = document.getElementById('unitRequests');
  const errorBox = document.getElementById('unitRequestMessage');
  const noticeBox = document.getElementById('unitRequestNotice');
  const filter = document.getElementById('unitRequestFilter');
  const refresh = document.getElementById('unitRequestRefresh');
  const count = document.getElementById('unitRequestCount');
  if (!root || !errorBox || !noticeBox || !filter || !refresh || !count) return;

  let requests = [];
  let loading = false;
  const money = value => `₱${Number(value || 0).toLocaleString('en-PH')}`;
  const item = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = String(value);
    return node;
  };
  const icon = name => item('i', `bi ${name}`);
  const date = (value, includeTime = false) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila', dateStyle: 'medium', ...(includeTime ? { timeStyle: 'short' } : {}),
    }).format(parsed);
  };
  const quoteValid = request => Boolean(request.quote?.expiresAt && new Date(request.quote.expiresAt) > new Date());
  const actionNeeded = request => request.status === 'quoted' || (request.status === 'accepted' && !request.existingBookingId);
  const inProgress = request => request.status === 'pending' || (request.status === 'accepted' && Boolean(request.existingBookingId));

  function setError(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
    if (message) errorBox.scrollIntoView({ block: 'nearest' });
  }
  function showSuccess(title, message) {
    const mark = item('span', 'uac-notice-icon');
    mark.append(icon('bi-check-lg'));
    mark.setAttribute('aria-hidden', 'true');
    const copy = item('div', 'uac-notice-copy');
    copy.append(item('strong', '', title), item('span', '', message));
    const close = item('button', 'uac-notice-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss success message');
    close.append(icon('bi-x-lg'));
    close.addEventListener('click', () => { noticeBox.hidden = true; });
    noticeBox.hidden = false;
    noticeBox.replaceChildren(mark, copy, close);
  }
  function link(label, href, primary = false) {
    const node = item('a', `uac-button ${primary ? 'uac-button-primary' : 'uac-button-light'}`, label);
    node.href = href;
    return node;
  }
  function note(message, type = 'info', iconName = 'bi-info-circle') {
    const node = item('div', `uac-guidance uac-guidance-${type}`);
    const symbol = icon(iconName);
    symbol.setAttribute('aria-hidden', 'true');
    node.append(symbol, item('p', '', message));
    return node;
  }
  function status(request) {
    if (request.status === 'pending') return ['Staff reviewing', 'pending'];
    if (request.status === 'quoted') return quoteValid(request) ? ['Review your quote', 'action'] : ['Quote expired', 'expired'];
    if (request.status === 'accepted') {
      if (request.existingBookingId) return ['Change accepted', 'accepted'];
      return quoteValid(request) ? ['Ready to book', 'action'] : ['Quote expired', 'expired'];
    }
    if (request.status === 'converted') return ['Booking created', 'done'];
    if (request.status === 'resolved') return ['Request handled', 'done'];
    if (request.status === 'declined') return ['Declined', 'neutral'];
    return [String(request.status || 'Request').replaceAll('_', ' '), 'neutral'];
  }
  function appendActions(parent, ...actions) {
    const bar = item('div', 'uac-actions');
    bar.append(...actions);
    parent.append(bar);
  }
  async function decide(request, decision, card) {
    if (card.getAttribute('aria-busy') === 'true') return;
    card.setAttribute('aria-busy', 'true');
    card.querySelectorAll('.uac-actions button').forEach(button => { button.disabled = true; });
    setError('');
    try {
      const response = await fetch(`/api/unit-assistance/mine/${encodeURIComponent(request._id)}/decision`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not save your choice. Please try again.');
      if (decision === 'accept' && !request.existingBookingId) {
        location.assign(`/services?assistanceId=${encodeURIComponent(request._id)}`);
        return;
      }
      request.status = result.status || (decision === 'accept' ? 'accepted' : 'declined');
      render();
      await load();
      showSuccess(decision === 'accept' ? 'Quote accepted' : 'Quote declined', decision === 'accept'
        ? 'Staff will review the change to your existing booking. You can track the booking in My Bookings.'
        : 'Your decision was saved. You can browse services whenever you are ready.');
    } catch (error) {
      setError(error.message);
      card.setAttribute('aria-busy', 'false');
      card.querySelectorAll('.uac-actions button').forEach(button => { button.disabled = false; });
    }
  }
  function decisionButton(label, decision, card, request, primary = false) {
    const button = item('button', `uac-button ${primary ? 'uac-button-primary' : 'uac-button-light'}`, label);
    button.type = 'button';
    button.addEventListener('click', () => decide(request, decision, card));
    return button;
  }
  function detailNote(label, value) {
    const detail = item('details', 'uac-detail-note');
    detail.append(item('summary', '', label), item('p', '', value));
    return detail;
  }
  function renderCard(request) {
    const card = item('article', 'uac-card');
    const head = item('div', 'uac-card-head');
    const symbol = item('span', 'uac-service-icon');
    symbol.append(icon('bi-snow'));
    symbol.setAttribute('aria-hidden', 'true');
    const heading = item('div', 'uac-card-title');
    heading.append(item('span', 'uac-category', request.existingBookingId ? 'Existing booking change' : 'Aircon service'));
    heading.append(item('h3', '', request.serviceName || 'Aircon service'));
    heading.append(item('p', '', `Requested ${date(request.createdAt)} · ${request.quantity || 1} ${Number(request.quantity) === 1 ? 'unit' : 'units'}`));
    const [statusLabel, statusType] = status(request);
    head.append(symbol, heading, item('span', `uac-status uac-status-${statusType}`, statusLabel));
    card.append(head);

    const body = item('div', 'uac-card-body');
    if (request.relocation?.scope === 'same_property') {
      body.append(detailNote('From · current position', request.relocation.fromPosition || 'Not provided'));
      body.append(detailNote('To · new position', request.relocation.toPosition || 'Not provided'));
    }
    if (request.existingBookingId) {
      const booking = item('div', 'uac-booking-ref');
      booking.append(icon('bi-link-45deg'), item('span', '', `Booking ${request.existingBookingReference || request.existingBookingId}`));
      body.append(booking);
    }
    if (request.status === 'pending') {
      body.append(note('Staff will confirm your aircon details and send a price here. No schedule or payment is required yet.'));
      if (request.notes) body.append(detailNote('Details you shared', request.notes));
    }
    if (request.quote) {
      const quote = item('div', 'uac-quote');
      const details = item('div', 'uac-unit');
      details.append(item('span', 'uac-label', 'Verified unit'));
      const unit = [request.quote.brand || 'Brand not provided', request.quote.airconTypeName || request.quote.airconType || 'Aircon',
        request.quote.hp ? `${request.quote.hp} HP` : null].filter(Boolean).join(' · ');
      details.append(item('strong', '', unit));
      if (request.quote.notes) details.append(detailNote('Staff notes', request.quote.notes));
      const price = item('div', 'uac-price');
      price.append(item('span', 'uac-label', 'Service quote'));
      price.append(item('strong', 'uac-price-total', money(Number(request.quote.unitPrice) * Number(request.quantity || 1))));
      price.append(item('span', 'uac-price-breakdown', `${money(request.quote.unitPrice)} per unit · ${request.quantity || 1} ${Number(request.quantity) === 1 ? 'unit' : 'units'}`));
      price.append(item('small', '', 'Before any travel fare.'));
      quote.append(details, price);
      body.append(quote);
    }
    if (request.status === 'quoted') {
      if (quoteValid(request)) {
        body.append(note(request.existingBookingId
          ? `Quote valid until ${date(request.quote.expiresAt, true)}. If you accept, staff will review your booking change and any payment adjustment.`
          : `Quote valid until ${date(request.quote.expiresAt, true)}. Scheduling happens after you accept; availability is checked when you book.`, 'info', 'bi-clock'));
        appendActions(body,
          decisionButton(request.existingBookingId ? 'Accept service change quote' : 'Accept and choose schedule', 'accept', card, request, true),
          decisionButton('Decline quote', 'decline', card, request));
      } else {
        body.append(note('This quote has expired. Please contact the store for an updated quote.', 'warning', 'bi-exclamation-circle'));
        appendActions(body, link('Contact the store', '/contact'));
      }
    }
    if (request.status === 'accepted') {
      if (request.existingBookingId) {
        body.append(note('Staff will update your existing booking and review any payment adjustment. Your current booking remains visible in My Bookings.', 'success', 'bi-check-circle'));
        appendActions(body, link('View my bookings', '/book-history'));
      } else if (quoteValid(request)) {
        body.append(note('Your quote is accepted. Continue to choose a location and schedule; the final amount may include travel fare.', 'success', 'bi-check-circle'));
        appendActions(body, link('Continue booking', `/services?assistanceId=${encodeURIComponent(request._id)}`, true));
      } else {
        body.append(note('This quote expired before booking. Please contact the store for an updated quote.', 'warning', 'bi-exclamation-circle'));
        appendActions(body, link('Contact the store', '/contact'));
      }
    }
    if (request.status === 'converted') {
      body.append(note('Your request became a booking. Check My Bookings for its current status.', 'success', 'bi-check-circle'));
      appendActions(body, link('View my bookings', '/book-history'));
    }
    if (request.status === 'resolved') {
      body.append(note('Staff handled this request. Review My Bookings for the updated status.', 'success', 'bi-check-circle'));
      appendActions(body, link('View my bookings', '/book-history'));
    }
    if (request.status === 'declined') body.append(note('You declined this quote. You can browse services to start a new request when ready.', 'neutral', 'bi-dash-circle'));
    card.append(body);
    return card;
  }
  function render() {
    const visible = requests.filter(request => filter.value === 'all' ||
      (filter.value === 'action' && actionNeeded(request)) ||
      (filter.value === 'progress' && inProgress(request)) ||
      (filter.value === 'past' && ['declined', 'converted', 'resolved'].includes(request.status)));
    count.textContent = `${visible.length} of ${requests.length} ${requests.length === 1 ? 'request' : 'requests'}`;
    root.replaceChildren();
    if (!visible.length) {
      const empty = item('div', 'uac-empty');
      const symbol = icon(requests.length ? 'bi-funnel' : 'bi-clipboard2-plus');
      symbol.setAttribute('aria-hidden', 'true');
      empty.append(symbol, item('h3', '', requests.length ? 'No requests in this view' : 'No requests yet'));
      empty.append(item('p', '', requests.length ? 'Choose another filter to see your requests.' : 'If you are unsure about your aircon details, start from a service and staff can help identify your unit.'));
      if (!requests.length) empty.append(link('Browse services', '/services', true));
      root.append(empty);
      return;
    }
    visible.forEach(request => root.append(renderCard(request)));
  }
  async function load() {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    try {
      const response = await fetch('/api/unit-assistance/mine', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not load requests. Please try again.');
      requests = Array.isArray(data.requests) ? data.requests : [];
      setError('');
      render();
    } catch (error) {
      setError(error.message);
      if (!requests.length) root.replaceChildren(item('div', 'uac-empty', 'Your requests could not load. Select Refresh to try again.'));
    } finally {
      loading = false;
      refresh.disabled = false;
    }
  }
  filter.addEventListener('change', render);
  refresh.addEventListener('click', load);
  load();
})();
