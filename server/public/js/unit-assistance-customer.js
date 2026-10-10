(() => {
  'use strict';
  const quoteValid = (request, now = Date.now()) => Boolean(request.quote?.expiresAt && new Date(request.quote.expiresAt).getTime() > now);
  function requestCategory(request, now = Date.now()) {
    if (request.status === 'pending' || (request.status === 'accepted' && request.existingBookingId)) return 'progress';
    if (['quoted', 'accepted'].includes(request.status) && quoteValid(request, now)) return 'action';
    return 'past';
  }
  const requestReference = request => 'REQ-' + String(request._id || '').slice(-8).toUpperCase();
  function selectRequests(requests, category = 'all', search = '', now = Date.now()) {
    const term = String(search).trim().toLowerCase();
    const rank = { action:0, progress:1, past:2 };
    return requests.filter(request => (category === 'all' || requestCategory(request, now) === category) &&
      (!term || [requestReference(request), request._id, request.serviceName, request.brand, request.airconType, request.hp,
        request.existingBookingReference, request.notes, request.quote?.brand, request.quote?.airconTypeName,
        request.quote?.airconType, request.quote?.hp].filter(value => value != null).join(' ').toLowerCase().includes(term)))
      .sort((a,b) => rank[requestCategory(a, now)] - rank[requestCategory(b, now)] ||
        (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));
  }
  if (typeof module === 'object' && module.exports) module.exports = { quoteValid, requestCategory, requestReference, selectRequests };
  if (typeof document === 'undefined') return;

  const root = document.getElementById('unitRequests');
  const errorBox = document.getElementById('unitRequestMessage');
  const noticeBox = document.getElementById('unitRequestNotice');
  const search = document.getElementById('unitRequestSearch');
  const refresh = document.getElementById('unitRequestRefresh');
  const count = document.getElementById('unitRequestCount');
  const filters = Array.from(document.querySelectorAll('[data-unit-filter]'));
  const previous = document.getElementById('unitRequestPrev'), next = document.getElementById('unitRequestNext');
  const pageLabel = document.getElementById('unitRequestPage');
  if (!root || !errorBox || !noticeBox || !search || !refresh || !count || !previous || !next || !pageLabel) return;

  let requests = [], loading = false, loaded = false, activeFilter = 'all', page = 1;
  const pageSize = 6, pendingDecisions = new Set();
  const money = value => new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP', minimumFractionDigits:2, maximumFractionDigits:2 }).format(Number(value) || 0);
  const item = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = String(value);
    return node;
  };
  const iconPaths = {
    'bi-snow':['M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4 18.4 5.6','m9 4 3 3 3-3m-6 16 3-3 3 3M4 9l3 3-3 3m16-6-3 3 3 3'],
    'bi-info-circle':['M12 11v6M12 7v.5'], 'bi-clock':['M12 7v5l3 2'],
    'bi-check-circle':['m8 12 3 3 5-6'], 'bi-exclamation-circle':['M12 7v6M12 16v.5'],
    'bi-dash-circle':['M8 12h8'], 'bi-check-lg':['m5 12 4 4L19 6'], 'bi-x-lg':['m6 6 12 12M6 18 18 6'],
    'bi-link-45deg':['m10 13 4-4','M8 14 6 16a3 3 0 0 0 4 4l4-4a3 3 0 0 0 0-4M10 8l4-4a3 3 0 0 1 4 4l-2 2'],
    'bi-funnel':['M4 4h16l-6 8v6l-4 2v-8Z'],
    'bi-clipboard2-plus':['M9 4H6v17h12V4h-3M9 3h6v3H9ZM9 14h6M12 11v6'],
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor');
    svg.setAttribute('stroke-width','1.7'); svg.setAttribute('stroke-linecap','round'); svg.setAttribute('stroke-linejoin','round'); svg.setAttribute('aria-hidden','true');
    if (['bi-info-circle','bi-clock','bi-check-circle','bi-exclamation-circle','bi-dash-circle'].includes(name)) {
      const circle = document.createElementNS(svg.namespaceURI,'circle'); circle.setAttribute('cx','12'); circle.setAttribute('cy','12'); circle.setAttribute('r','9'); svg.append(circle);
    }
    (iconPaths[name] || iconPaths['bi-info-circle']).forEach(d => { const node = document.createElementNS(svg.namespaceURI,'path'); node.setAttribute('d',d); svg.append(node); });
    return svg;
  }
  const date = (value, includeTime = false) => {
    if (!value) return 'Date unavailable';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-PH', {
      timeZone:'Asia/Manila', dateStyle:'medium', ...(includeTime ? { timeStyle:'short' } : {}),
    }).format(parsed);
  };
  const typeName = value => ({ split:'Split type', window:'Window type', cassette:'Cassette', floor_mounted:'Floor mounted',
    floor_standing:'Floor standing', split_suspended:'Ceiling suspended', central:'Central aircon' }[value] || String(value || '').replaceAll('_',' '));
  function setError(message) {
    errorBox.textContent = message || ''; errorBox.hidden = !message;
    if (message) { errorBox.focus({ preventScroll:true }); errorBox.scrollIntoView({ block:'nearest', behavior:'smooth' }); }
  }
  function showSuccess(title, message) {
    const mark = item('span','uac-notice-icon'); mark.append(icon('bi-check-lg'));
    const copy = item('div','uac-notice-copy'); copy.append(item('strong','',title),item('span','',message));
    const close = item('button','uac-notice-close'); close.type = 'button'; close.setAttribute('aria-label','Dismiss success message');
    close.append(icon('bi-x-lg')); close.addEventListener('click',() => { noticeBox.hidden = true; });
    noticeBox.replaceChildren(mark,copy,close); noticeBox.hidden = false;
  }
  function link(label, href, primary = false) {
    const node = item('a','uac-button ' + (primary ? 'uac-button-primary' : 'uac-button-light'),label); node.href = href; return node;
  }
  function note(message, type = 'info', iconName = 'bi-info-circle') {
    const node = item('div','uac-guidance uac-guidance-' + type); node.append(icon(iconName),item('p','',message)); return node;
  }
  function status(request) {
    if (request.status === 'pending') return ['Staff reviewing','pending'];
    if (request.status === 'quoted') return quoteValid(request) ? ['Quote ready','action'] : ['Quote expired','expired'];
    if (request.status === 'accepted') return request.existingBookingId ? ['Change accepted','accepted'] :
      quoteValid(request) ? ['Ready to book','action'] : ['Quote expired','expired'];
    if (request.status === 'converted') return ['Booking created','done'];
    if (request.status === 'resolved') return ['Completed','done'];
    if (request.status === 'declined') return ['Declined','neutral'];
    return [String(request.status || 'Request').replaceAll('_',' '),'neutral'];
  }
  function appendActions(parent,...actions) { const bar = item('div','uac-actions'); bar.append(...actions); parent.append(bar); }
  async function decide(request, decision, card) {
    if (pendingDecisions.has(request._id)) return;
    if (!quoteValid(request)) { setError('This quote has expired. Contact our team for an updated price.'); render(); return; }
    pendingDecisions.add(request._id); card.setAttribute('aria-busy','true'); refresh.disabled = true;
    card.querySelectorAll('.uac-actions button').forEach(button => { button.disabled = true; });
    setError('');
    try {
      const response = await fetch('/api/unit-assistance/mine/' + encodeURIComponent(request._id) + '/decision', {
        method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ decision }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not save your choice. Please try again.');
      request.status = result.status || (decision === 'accept' ? 'accepted' : 'declined');
      if (decision === 'accept' && !request.existingBookingId) { location.assign('/services?assistanceId=' + encodeURIComponent(request._id)); return; }
      render();
      showSuccess(decision === 'accept' ? 'Quote accepted' : 'Quote declined', decision === 'accept'
        ? 'Staff will review the change and any payment adjustment. Track the update in My bookings.'
        : 'Your decision was saved. You can browse services whenever you’re ready.');
      document.dispatchEvent(new CustomEvent('booking:updated'));
    } catch (error) { setError(error.message); }
    finally { pendingDecisions.delete(request._id); refresh.disabled = loading || pendingDecisions.size > 0; render(); }
  }
  function decisionButton(label,decision,card,request,primary = false) {
    const button = item('button','uac-button ' + (primary ? 'uac-button-primary' : 'uac-button-light'),label);
    button.type = 'button'; button.disabled = pendingDecisions.has(request._id);
    button.addEventListener('click',() => decide(request,decision,card)); return button;
  }
  function detailNote(label,value) {
    const detail = item('details','uac-detail-note'); detail.append(item('summary','',label),item('p','',value)); return detail;
  }
  function unitDetails(request, verified) {
    const unit = verified ? request.quote : request;
    const grid = item('div','uac-unit-grid');
    const type = unit.airconTypeName || typeName(unit.airconType);
    const unitType = [type,unit.hp ? unit.hp + ' HP' : 'HP to confirm'].filter(Boolean).join(' · ');
    for (const [label,value] of [['Brand',unit.brand && unit.brand !== "I don't know" ? unit.brand : 'To be identified'],
      [verified ? 'Verified unit' : 'Unit details',unitType || 'To be identified'],['Quantity',(Number(request.quantity) || 1) + (Number(request.quantity) === 1 ? ' unit' : ' units')]]) {
      const field = item('div','uac-unit-field'); field.append(item('span','uac-label',label),item('strong','',value)); grid.append(field);
    }
    return grid;
  }
  function renderCard(request) {
    const card = item('article','uac-card'); card.dataset.requestId = request._id; card.setAttribute('aria-busy',pendingDecisions.has(request._id) ? 'true' : 'false');
    const head = item('div','uac-card-head'), symbol = item('span','uac-service-icon'); symbol.append(icon('bi-snow'));
    const heading = item('div','uac-card-title'); heading.append(item('h3','',request.serviceName || 'Aircon service'));
    const meta = item('p',''); const reference = item('span','uac-reference',requestReference(request)); reference.title = String(request._id || '');
    meta.append(reference,item('span','','·'),item('span','',date(request.createdAt)),item('span','','·'),item('span','',request.existingBookingId ? 'Booking change' : 'New booking'));
    heading.append(meta);
    const [statusLabel,statusType] = status(request); head.append(symbol,heading,item('span','uac-status uac-status-' + statusType,statusLabel)); card.append(head);
    const body = item('div','uac-card-body');
    if (request.existingBookingId) {
      const booking = item('a','uac-booking-ref'); booking.href = '/book-history';
      booking.append(icon('bi-link-45deg'),item('span','','Booking ' + (request.existingBookingReference || request.existingBookingId))); body.append(booking);
    }
    const hasQuote = request.quote?.unitPrice != null && String(request.quote.unitPrice).trim() !== '' && Number.isFinite(Number(request.quote.unitPrice));
    if (hasQuote) {
      const quote = item('div','uac-quote'), price = item('div','uac-price');
      price.append(item('span','uac-label','Service quote'),item('strong','uac-price-total',money(Number(request.quote.unitPrice) * Number(request.quantity || 1))),
        item('span','uac-price-breakdown',money(request.quote.unitPrice) + ' / unit · before travel fare'));
      quote.append(unitDetails(request,true),price); body.append(quote);
    } else body.append(unitDetails(request,false));
    const details = item('div','uac-detail-notes');
    if (request.notes) details.append(detailNote('Your notes',request.notes));
    if (request.quote?.notes) details.append(detailNote('Staff notes',request.quote.notes));
    if (request.relocation?.scope === 'same_property') {
      details.append(detailNote('Current position',request.relocation.fromPosition || 'Not provided'),detailNote('New position',request.relocation.toPosition || 'Not provided'));
    }
    if (details.children.length) body.append(details);
    const footer = item('div','uac-card-footer');
    if (request.status === 'pending') footer.append(note('We’ll confirm your unit and send a quote here. No payment or appointment is required yet.','info','bi-clock'));
    if (request.status === 'quoted') {
      if (quoteValid(request)) {
        footer.append(note('Valid until ' + date(request.quote.expiresAt,true) + (request.existingBookingId ? '. Staff will review your booking change after acceptance.' : '. Choose a schedule after accepting.'),'info','bi-clock'));
        appendActions(footer,decisionButton(request.existingBookingId ? 'Accept quote' : 'Accept & book','accept',card,request,true),decisionButton('Decline','decline',card,request));
      } else {
        footer.append(note('This quote expired. Contact our team for an updated price.','warning','bi-exclamation-circle')); appendActions(footer,link('Contact team','/contact'));
      }
    }
    if (request.status === 'accepted') {
      if (request.existingBookingId) {
        footer.append(note('Quote accepted. Staff will review your booking change and any payment adjustment.','success','bi-check-circle'));
        appendActions(footer,link('View booking','/book-history'));
      } else if (quoteValid(request)) {
        footer.append(note('Quote accepted. Choose your location and schedule to finish booking.','success','bi-check-circle'));
        appendActions(footer,link('Continue booking','/services?assistanceId=' + encodeURIComponent(request._id),true));
      } else {
        footer.append(note('This quote expired before booking. Contact our team for an updated price.','warning','bi-exclamation-circle')); appendActions(footer,link('Contact team','/contact'));
      }
    }
    if (['converted','resolved'].includes(request.status)) {
      footer.append(note(request.status === 'converted' ? 'Booking created. Track its progress in My bookings.' : 'Staff has handled this request. Check your booking for the latest update.','success','bi-check-circle'));
      appendActions(footer,link('View booking','/book-history'));
    }
    if (request.status === 'declined') footer.append(note('Quote declined. You can start another request whenever you’re ready.','neutral','bi-dash-circle'));
    if (footer.children.length) body.append(footer);
    card.append(body); return card;
  }
  function render() {
    const now = Date.now(), totals = { all:requests.length,action:0,progress:0,past:0 };
    requests.forEach(request => totals[requestCategory(request,now)]++);
    for (const [id,key] of [['unitTotalCount','all'],['unitActionCount','action'],['unitProgressCount','progress'],['unitPastCount','past']]) {
      const node = document.getElementById(id); if (node) node.textContent = String(totals[key]);
    }
    filters.forEach(button => {
      button.setAttribute('aria-pressed',String(button.dataset.unitFilter === activeFilter));
      const badge = button.querySelector('[data-unit-count]'); if (badge) badge.textContent = String(totals[button.dataset.unitFilter]);
    });
    const visible = selectRequests(requests,activeFilter,search.value,now);
    const pages = Math.max(1,Math.ceil(visible.length / pageSize)); page = Math.max(1,Math.min(page,pages));
    const start = (page - 1) * pageSize;
    count.textContent = visible.length ? 'Showing ' + (start + 1) + '–' + Math.min(start + pageSize,visible.length) + ' of ' + visible.length + ' requests' : '0 requests';
    pageLabel.textContent = 'Page ' + page + ' of ' + pages; previous.disabled = page <= 1; next.disabled = page >= pages;
    root.replaceChildren();
    if (!visible.length) {
      const empty = item('div','uac-empty'); empty.append(icon(requests.length ? 'bi-funnel' : 'bi-clipboard2-plus'));
      empty.append(item('h3','',requests.length ? 'No matching requests' : 'Your requests will appear here'));
      empty.append(item('p','',requests.length ? 'Try a different search or filter to find your request.' : 'Unsure about your aircon type or HP? Choose a service and request help identifying your unit.'));
      if (!requests.length) empty.append(link('Browse services','/services',true));
      else {
        const reset = item('button','uac-button uac-button-light','Clear filters'); reset.type = 'button';
        reset.addEventListener('click',() => { activeFilter = 'all'; search.value = ''; page = 1; render(); }); empty.append(reset);
      }
      root.append(empty); return;
    }
    visible.slice(start,start + pageSize).forEach(request => root.append(renderCard(request)));
  }
  async function load() {
    if (loading || pendingDecisions.size) return;
    loading = true; refresh.disabled = true; root.setAttribute('aria-busy','true');
    try {
      const response = await fetch('/api/unit-assistance/mine',{ credentials:'same-origin', cache:'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(data?.requests)) throw new Error(response.status === 401
        ? 'Your session expired. Sign in again to view your requests.' : data?.error || 'Could not load requests. Select Refresh to try again.');
      requests = data.requests; loaded = true; setError(''); render();
    } catch (error) {
      setError(error.message);
      if (!loaded) { root.replaceChildren(item('div','uac-empty','Your requests could not load. Select Refresh to try again.')); count.textContent = 'Requests unavailable'; }
    } finally { loading = false; refresh.disabled = pendingDecisions.size > 0; root.setAttribute('aria-busy','false'); }
  }
  filters.forEach(button => button.addEventListener('click',() => { activeFilter = button.dataset.unitFilter; page = 1; render(); }));
  search.addEventListener('input',() => { page = 1; render(); });
  previous.addEventListener('click',() => { page--; render(); document.getElementById('uacSectionTitle')?.scrollIntoView({ block:'start',behavior:'smooth' }); });
  next.addEventListener('click',() => { page++; render(); document.getElementById('uacSectionTitle')?.scrollIntoView({ block:'start',behavior:'smooth' }); });
  refresh.addEventListener('click',load);
  document.addEventListener('visibilitychange',() => { if (!document.hidden) load(); });
  load();
})();
