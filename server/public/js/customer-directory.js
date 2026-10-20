(function () {
  'use strict';
  window.CustomerDirectory = { init: function (config) {
    // The shared layouts load Bootstrap after the page body.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => window.CustomerDirectory.init(config), { once: true });
      return;
    }
    const get = id => document.getElementById(id);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const date = (value, time) => {
      if (!value || !Number.isFinite(new Date(value).getTime())) return time ? 'No sign-in recorded' : 'Not recorded';
      return new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric',
        ...(time ? { hour: 'numeric', minute: '2-digit' } : {}) });
    };
    const name = customer => [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Customer';
    const initials = customer => [customer.firstName, customer.lastName].map(part => String(part || '').charAt(0)).join('') || 'C';
    const status = customer => customer.blocked ? ['Blocked', 'danger'] : customer.accountStatus === 'invited' ? ['Awaiting activation', 'info'] : ['Active', 'success'];
    const badges = customer => {
      const [label, color] = status(customer);
      return '<span class="badge bg-' + color + '-subtle text-' + color + '">' + label + '</span>';
    };
    const modal = get('customerDetailModal'), body = get('customerModalBody'), footer = get('customerModalFooter');
    const modalInstance = bootstrap.Modal.getOrCreateInstance(modal);
    let page = 0, total = 0, limit = 10, listController, detailController, contactController, revision = 0, debounce;
    const loading = '<div class="loading-spinner" role="status"><span class="spinner-border"></span><span class="visually-hidden">Loading customers</span></div>';
    const card = (label, value) => '<div class="ent-detail-card"><dt class="ent-detail-label">' + esc(label) + '</dt><dd class="ent-detail-value mb-0">' + esc(value || 'Not provided') + '</dd></div>';
    const request = async (url, options = {}) => {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
      if (!response.ok) throw new Error(response.status === 403 ? 'You do not have permission to do this.' : response.status === 404 ? 'This customer record is no longer available.' : 'We could not complete the request. Please try again.');
      return response.json();
    };

    function renderPagination() {
      const pages = Math.max(1, Math.ceil(total / limit));
      get('customerPagination').innerHTML = '<li class="page-item"><button type="button" class="page-link" data-page="' + (page - 1) + '"' + (page === 0 ? ' disabled' : '') + '>Previous</button></li>' +
        '<li class="customer-page-summary">Page ' + (page + 1) + ' of ' + pages + '</li>' +
        '<li class="page-item"><button type="button" class="page-link" data-page="' + (page + 1) + '"' + (page + 1 >= pages ? ' disabled' : '') + '>Next</button></li>';
    }
    async function loadCustomers(reset) {
      if (reset) page = 0;
      if (listController) listController.abort();
      const controller = listController = new AbortController();
      get('customerTableBody').innerHTML = '<tr><td colspan="5">' + loading + '</td></tr>';
      get('customerCountLabel').textContent = 'Loading…';
      get('customerPagination').innerHTML = '';
      const query = new URLSearchParams({ page, limit, search: get('customerSearchInput').value.trim(), status: get('customerStatusFilter').value });
      try {
        const data = await request(config.apiBase + '?' + query, { signal: controller.signal });
        if (controller !== listController) return;
        total = Number(data.total) || 0; limit = Number(data.limit) || 10;
        if (page > 0 && page * limit >= total) { page = Math.max(0, Math.ceil(total / limit) - 1); return loadCustomers(); }
        for (const [key, id] of Object.entries({ total: 'custTotal', active: 'custActive', blocked: 'custBlocked' })) get(id).textContent = Number(data.stats?.[key] || 0).toLocaleString();
        get('customerCountLabel').textContent = total ? 'Showing ' + (page * limit + 1) + '–' + Math.min((page + 1) * limit, total) + ' of ' + total.toLocaleString() : 'No matching customers';
        get('customerTableBody').innerHTML = data.customers.length ? data.customers.map(customer => '<tr>' +
          '<td data-label="Customer"><div class="d-flex align-items-center gap-2"><span class="customer-avatar bg-primary-subtle text-primary" aria-hidden="true">' + esc(initials(customer)) + '</span><div class="customer-name"><strong>' + esc(name(customer)) + '</strong><small class="d-block text-muted">Customer #' + esc(String(customer._id).slice(-6).toUpperCase()) + '</small></div></div></td>' +
          '<td data-label="Contact"><span class="d-block">' + esc(customer.email || 'No email') + '</span><small class="text-muted">' + esc(customer.phone || 'No phone') + '</small></td>' +
          '<td data-label="Status"><div class="d-flex flex-wrap gap-1">' + badges(customer) + '</div></td>' +
          '<td data-label="Joined">' + esc(date(customer.createdAt)) + '</td>' +
          '<td data-label="Actions"><button type="button" class="btn btn-sm btn-outline-primary view-customer-btn" data-id="' + esc(customer._id) + '" aria-label="View details for ' + esc(name(customer)) + '"><i class="bi bi-eye me-1" aria-hidden="true"></i>View details</button></td></tr>').join('') :
          '<tr><td colspan="5"><div class="empty-state"><i class="bi bi-people" aria-hidden="true"></i><p class="mb-0">No customers match your search or status filter.</p></div></td></tr>';
        renderPagination();
      } catch (error) {
        if (error.name === 'AbortError' || controller !== listController) return;
        get('customerCountLabel').textContent = 'Could not load customers';
        get('customerTableBody').innerHTML = '<tr><td colspan="5"><div class="empty-state" role="alert"><p>' + esc(error.message) + '</p><button type="button" class="btn btn-outline-primary" data-retry-list>Try again</button></div></td></tr>';
      }
    }

    function maskedContact(customer) {
      return '<dl class="customer-detail-grid mb-3">' + card('Email', customer.email) + card('Phone', customer.phone) + '</dl>' +
        '<p class="text-muted small mb-3">Contact details and the profile address are hidden. Show them when you need to assist this customer. Access is recorded in the audit trail.</p>' +
        '<button type="button" class="btn btn-sm btn-outline-primary" data-show-contact><i class="bi bi-eye me-1" aria-hidden="true"></i>Show contact details</button><div id="customerContactError" role="alert" class="small text-danger mt-2"></div>';
    }
    async function resolveAddress(address, signal) {
      const codes = [address.barangay, address.city, address.province].filter(value => /^\d{6,10}$/.test(value || ''));
      let resolved = {};
      if (codes.length) {
        const lookup = new AbortController(), abort = () => lookup.abort();
        signal.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(abort, 8000);
        try { resolved = (await request('/api/psgc/resolve?codes=' + encodeURIComponent(codes.join(',')), { signal: lookup.signal })).resolved || {}; }
        catch (error) { if (signal.aborted) throw error; }
        finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
      }
      return ['barangay', 'city', 'province'].map(key => {
        const value = address[key] || '';
        return /^\d{6,10}$/.test(value) ? resolved[value] || 'Name unavailable' : value;
      });
    }
    function bindContact(customer, version) {
      if (contactController) contactController.abort();
      const section = get('customerContactSection');
      section.innerHTML = maskedContact(customer);
      section.querySelector('[data-show-contact]').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true; button.textContent = 'Loading contact details…';
        const controller = contactController = new AbortController();
        try {
          const data = await request(config.apiBase + '/' + encodeURIComponent(customer._id) + '/contact', { signal: controller.signal });
          const contact = data.contact, address = contact.address || {};
          if (version !== revision || controller.signal.aborted) return;
          const emailLink = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contact.email) ? '<a class="btn btn-sm btn-outline-primary" href="mailto:' + esc(encodeURIComponent(contact.email)) + '"><i class="bi bi-envelope me-1" aria-hidden="true"></i>Email customer</a>' : '';
          const phoneLink = /^\+?\d[\d\s()-]{6,20}$/.test(contact.phone) ? '<a class="btn btn-sm btn-outline-primary" href="tel:' + esc(contact.phone.replace(/[^+\d]/g, '')) + '"><i class="bi bi-telephone me-1" aria-hidden="true"></i>Call customer</a>' : '';
          section.innerHTML = '<dl class="customer-detail-grid mb-3">' + card('Email', contact.email) + card('Phone', contact.phone) + '</dl>' +
            '<div class="d-flex flex-wrap gap-2 mb-3">' + phoneLink + emailLink + '<button type="button" class="btn btn-sm btn-light border" data-hide-contact><i class="bi bi-eye-slash me-1" aria-hidden="true"></i>Hide details</button></div>' +
            '<h3 class="cust-modal-section-title">Profile address</h3><div data-address-details aria-live="polite"><p class="small text-muted">Loading address…</p></div>';
          section.querySelector('[data-hide-contact]').addEventListener('click', () => bindContact(customer, version));
          const [barangay, city, province] = await resolveAddress(address, controller.signal);
          if (version !== revision || controller.signal.aborted) return;
          section.querySelector('[data-address-details]').innerHTML = '<dl class="customer-detail-grid mb-0">' + card('Barangay', barangay) + card('City / municipality', city) + card('Province', province) + card('Postal code', address.postalCode) + '</dl>';
        } catch (error) {
          if (error.name === 'AbortError' || version !== revision) return;
          button.disabled = false; button.textContent = 'Show contact details';
          get('customerContactError').textContent = error.message;
        }
      });
    }

    function renderDetail(customer, version) {
      body.innerHTML = '<div class="customer-profile mb-4"><div class="cust-modal-avatar bg-primary-subtle text-primary" aria-hidden="true">' + esc(initials(customer)) + '</div><div class="customer-name"><h2 class="h5 mb-2">' + esc(name(customer)) + '</h2><div class="d-flex flex-wrap gap-1">' + badges(customer) + '</div><small class="text-muted d-block mt-2">Customer #' + esc(String(customer._id).slice(-6).toUpperCase()) + '</small></div></div>' +
        '<section class="mb-4" aria-labelledby="customerContactHeading"><h3 class="cust-modal-section-title" id="customerContactHeading">Contact information</h3><div id="customerContactSection"></div></section>' +
        '<section class="mb-4"><h3 class="cust-modal-section-title">Account activity</h3><dl class="customer-detail-grid mb-0">' + card('Joined', date(customer.createdAt)) + card('Last sign-in · Philippine time', date(customer.lastLogin, true)) + card('Booking limit', customer.bookingLimit || 'Unlimited') + card('Account concerns', customer.violations.length + ' recorded') + '</dl></section>' +
        (customer.violations.length ? '<section><h3 class="cust-modal-section-title">Account concerns</h3>' + customer.violations.map(item => '<div class="cust-violation-item"><div class="fw-semibold">' + esc(String(item.type || 'Account concern').replace(/[_-]+/g, ' ')) + '</div><p class="small my-1">' + esc(item.message || 'No further details recorded.') + '</p><small class="text-muted">' + esc(date(item.createdAt)) + '</small></div>').join('') + '</section>' : '');
      bindContact(customer, version);
      footer.innerHTML = '<div class="customer-modal-actions">' +
        ((customer.blocked ? config.canUnblock : config.canBlock) ? '<button type="button" class="btn ' + (customer.blocked ? 'btn-outline-success' : 'btn-outline-danger') + '" data-account-action>' + (customer.blocked ? 'Unblock account' : 'Block account') + '</button>' : '') +
        (config.apiBase === '/api/admin/customers' ? '<a class="btn btn-outline-primary" href="/admin/reports/customers/' + esc(encodeURIComponent(customer._id)) + '">Customer performance</a>' : '') +
        '<button type="button" class="btn btn-light border" data-bs-dismiss="modal">Close</button></div><div id="customerActionError" role="alert" class="small text-danger w-100"></div>';
      const action = footer.querySelector('[data-account-action]');
      if (action) action.addEventListener('click', async () => {
        const original = action.textContent;
        action.disabled = true; action.textContent = 'Saving…'; get('customerActionError').textContent = '';
        try {
          await request(config.apiBase + '/' + encodeURIComponent(customer._id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: customer.blocked ? 'unblock' : 'block' }) });
          if (version === revision) modalInstance.hide();
          await loadCustomers();
        } catch (error) {
          if (version !== revision) return;
          action.disabled = false; action.textContent = original; get('customerActionError').textContent = error.message;
        }
      });
    }
    async function openCustomer(id) {
      const version = ++revision;
      if (detailController) detailController.abort();
      if (contactController) contactController.abort();
      const controller = detailController = new AbortController();
      body.innerHTML = loading; footer.innerHTML = '<button type="button" class="btn btn-light border" data-bs-dismiss="modal">Close</button>';
      modalInstance.show();
      try {
        const data = await request(config.apiBase + '/' + encodeURIComponent(id), { signal: controller.signal });
        if (version !== revision) return;
        renderDetail(data.user, version);
      } catch (error) {
        if (error.name === 'AbortError' || version !== revision) return;
        body.innerHTML = '<div role="alert"><p>' + esc(error.message) + '</p><button type="button" class="btn btn-outline-primary" data-retry-detail>Try again</button></div>';
        body.querySelector('[data-retry-detail]').addEventListener('click', () => openCustomer(id));
      }
    }
    modal.addEventListener('hide.bs.modal', () => {
      ++revision;
      if (detailController) detailController.abort();
      if (contactController) contactController.abort();
      body.innerHTML = ''; footer.innerHTML = '';
    });
    get('customerTableBody').addEventListener('click', event => {
      const button = event.target.closest('.view-customer-btn');
      if (button) openCustomer(button.dataset.id);
      else if (event.target.closest('[data-retry-list]')) loadCustomers();
    });
    get('customerPagination').addEventListener('click', event => {
      const button = event.target.closest('[data-page]');
      if (!button || button.disabled) return;
      page = Number(button.dataset.page); loadCustomers();
    });
    const filter = () => { clearTimeout(debounce); loadCustomers(true); };
    get('customerFilterBtn').addEventListener('click', filter);
    get('customerStatusFilter').addEventListener('change', filter);
    get('customerSearchInput').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(filter, 350); });
    get('customerSearchInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); filter(); } });
    loadCustomers();
  } };
})();
