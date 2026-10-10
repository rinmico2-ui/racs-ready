(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else document.addEventListener('DOMContentLoaded', () => api.initOrders(document, root));
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function selectOrders(cards, filter, query, sort, page, pageSize = 8) {
    const search = query.trim().toLowerCase();
    const matching = cards.filter(card => (filter === 'all' || card.dataset.orderGroup === filter) && (!search || (card.dataset.orderSearch || '').includes(search)));
    matching.sort((a,b) => (Number(a.dataset.orderCreated) - Number(b.dataset.orderCreated)) * (sort === 'oldest' ? 1 : -1));
    const pages = Math.max(1, Math.ceil(matching.length / pageSize));
    const currentPage = Math.max(1, Math.min(page, pages));
    return { matching, visible:matching.slice((currentPage - 1) * pageSize,currentPage * pageSize), page:currentPage, pages };
  }
  function initOrders(doc, win) {
    doc.querySelectorAll('.ord-product-img').forEach(image => image.addEventListener('error', () => {
      const fallback = '/images/order-product-placeholder.svg';
      if (!image.src.endsWith(fallback)) image.src = fallback;
    }));
    const cards = Array.from(doc.querySelectorAll('.ord-card'));
    const filters = doc.querySelectorAll('.ord-filter-btn');
    const get = id => doc.getElementById(id);
    const search = get('orderSearch'), sort = get('orderSort');
    let activeFilter = 'all', page = 1;
    const pageSize = 8;
    function applyFilters() {
      const result = selectOrders(cards, activeFilter, search?.value || '', sort?.value || 'newest', page, pageSize);
      page = result.page;
      const visible = new Set(result.visible);
      cards.forEach(card => { card.hidden = !visible.has(card); });
      result.matching.forEach(card => get('ordersList').appendChild(card));
      filters.forEach(button => { button.classList.toggle('active', button.dataset.filter === activeFilter); button.setAttribute('aria-pressed', String(button.dataset.filter === activeFilter)); });
      get('orderNoResults').hidden = !cards.length || result.matching.length !== 0;
      if (get('orderResults')) get('orderResults').textContent = result.matching.length ? 'Showing ' + ((page - 1) * pageSize + 1) + '–' + Math.min(page * pageSize,result.matching.length) + ' of ' + result.matching.length + ' orders' : '0 matching orders';
      if (get('orderPrev')) {
        get('orderPrev').disabled = page <= 1; get('orderNext').disabled = page >= result.pages;
        get('orderPageSummary').textContent = 'Page ' + page + ' of ' + result.pages;
      }
    }
    filters.forEach(button => button.addEventListener('click', () => { activeFilter = button.dataset.filter; page = 1; applyFilters(); }));
    search?.addEventListener('input', () => { page = 1; applyFilters(); });
    sort?.addEventListener('change', () => { page = 1; applyFilters(); });
    get('resetOrderFilters')?.addEventListener('click', () => { activeFilter = 'all'; search.value = ''; page = 1; applyFilters(); search.focus(); });
    [['orderPrev',-1],['orderNext',1]].forEach(([id,offset]) => get(id)?.addEventListener('click', () => { page += offset; applyFilters(); get('ordersList').scrollIntoView({ block:'start' }); }));
    applyFilters();
    const feedback = doc.createElement('div');
    feedback.className = 'orders-feedback'; feedback.hidden = true; feedback.setAttribute('role','status');
    doc.querySelector('.orders-workspace').prepend(feedback);
    function showFeedback(message, refresh) {
      feedback.replaceChildren(); feedback.hidden = false;
      const text = doc.createElement('span'); text.textContent = message; feedback.appendChild(text);
      if (refresh) { const button = doc.createElement('button'); button.type = 'button'; button.className = 'ord-secondary-btn'; button.textContent = 'Refresh orders'; button.addEventListener('click', () => win.location.reload()); feedback.appendChild(button); }
    }
    if (typeof win.io === 'function') {
      const socket = win.io({ path:'/socket.io' });
      socket.on('order:status-change', () => showFeedback('An order has been updated. Refresh to see its latest status.', true));
    }
    doc.addEventListener('orders:reschedule-submitted', event => showFeedback(event.detail.message + ' Your current schedule remains until approval.', false));
    const params = new URLSearchParams(win.location.search);
    if (params.get('payment') === 'success') {
      showFeedback('Payment received. You can follow your order progress here.', false);
      params.delete('payment'); params.delete('orderId');
      win.history.replaceState({}, doc.title, win.location.pathname + (params.size ? '?' + params.toString() : ''));
    }
    doc.querySelectorAll('.ord-cancel-btn').forEach(button => button.addEventListener('click', async () => {
      let reason;
      if (win.Swal) {
        const result = await win.Swal.fire({ icon:'warning', title:'Cancel this order?', text:button.dataset.ref + ' will stop being processed.', input:'textarea', inputLabel:'Reason for cancellation', inputAttributes:{ maxlength:500 }, showCancelButton:true, confirmButtonText:'Cancel order', cancelButtonText:'Keep order', confirmButtonColor:'#b91c1c', reverseButtons:true, inputValidator:value => value?.trim() ? undefined : 'Please provide a cancellation reason.' });
        if (!result.isConfirmed) return; reason = result.value.trim();
      } else { reason = (win.prompt('Reason for cancelling ' + button.dataset.ref + ':') || '').trim(); if (!reason || !win.confirm('Cancel this order?')) return; }
      button.disabled = true;
      try {
        const response = await win.fetch('/api/orders/' + encodeURIComponent(button.dataset.id) + '/cancel', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ reason }) });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) throw new Error(data?.error || 'Unable to cancel this order. Please try again.');
        win.location.reload();
      } catch (error) { button.disabled = false; showFeedback(error.message, false); }
    }));
  }
  return { selectOrders, initOrders };
});
