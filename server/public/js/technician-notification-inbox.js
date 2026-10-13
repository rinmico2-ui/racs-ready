(function () {
  'use strict';

  function initialize() {
    const byId = id => document.getElementById(id);
    const modal = byId('notifModal');
    if (!modal || modal.dataset.inboxReady) return;
    modal.dataset.inboxReady = 'true';
    // Keep the dialog outside the fixed top bar's stacking context.
    document.body.appendChild(modal);
    const list = byId('notifModalList');
    const status = byId('notifModalStatus');
    const search = byId('notifSearch');
    const selectAll = byId('selectAllNotif');
    const selectedRead = byId('modalMarkSelectedRead');
    const selectedDelete = byId('modalDeleteSelected');
    const pagination = byId('notifPagination');
    const prev = byId('notifPrevPage');
    const next = byId('notifNextPage');
    const actions = ['markAllReadBtn', 'deleteAllBtn', 'modalMarkAllRead', 'modalMarkSelectedRead', 'modalDeleteSelected', 'modalDeleteAll'].map(byId);
    let notifications = [];
    let selected = new Set();
    let page = 1;
    let opened = false;
    let busy = false;
    let loading = false;
    let controller = null;
    let restoreFocus = null;
    let previousOverflow = '';
    const pageSize = 10;

    function message(text, error) {
      status.replaceChildren();
      status.textContent = text;
      status.classList.toggle('d-none', !text);
      status.classList.toggle('text-danger', !!error);
      const dropdownStatus = byId('notifDropdownStatus');
      if (dropdownStatus) {
        dropdownStatus.textContent = error ? text : '';
        dropdownStatus.classList.toggle('d-none', !error);
      }
    }

    function visible() {
      const query = search.value.trim().toLowerCase();
      return notifications.filter(n => String(n.title || '').toLowerCase().includes(query) || String(n.message || '').toLowerCase().includes(query));
    }

    function updateControls() {
      const blocked = busy || loading;
      actions.forEach(button => { button.disabled = blocked; });
      selectedRead.disabled = blocked || !selected.size;
      selectedDelete.disabled = blocked || !selected.size;
      selectAll.disabled = blocked || !visible().length;
      const pageItems = visible().slice((page - 1) * pageSize, page * pageSize);
      selectAll.checked = pageItems.length > 0 && pageItems.every(n => selected.has(n._id));
      selectAll.indeterminate = !selectAll.checked && pageItems.some(n => selected.has(n._id));
      prev.disabled = blocked || page <= 1;
      next.disabled = blocked || page >= Math.ceil(visible().length / pageSize);
      list.querySelectorAll('.notif-checkbox, .notif-modal-item').forEach(el => {
        if (el.type === 'checkbox') el.disabled = blocked;
        else el.setAttribute('aria-disabled', String(blocked));
      });
      byId('notifPageNumbers').querySelectorAll('button').forEach(button => { button.disabled = blocked; });
      modal.setAttribute('aria-busy', String(blocked));
    }

    function destination(link) {
      try {
        const url = new URL(link || '/technician#dashboardNotifications', window.location.href);
        if (url.origin === window.location.origin && /^https?:$/.test(url.protocol) && /^\/technician(?:\/|$)/.test(url.pathname)) return url.pathname + url.search + url.hash;
      } catch (_) {}
      return '/technician#dashboardNotifications';
    }

    function timeAgo(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
      if (!minutes) return 'Just now';
      if (minutes < 60) return minutes + 'm ago';
      if (minutes < 1440) return Math.floor(minutes / 60) + 'h ago';
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function make(tag, className, text) {
      const el = document.createElement(tag);
      el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    }

    function render() {
      const filtered = visible();
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      page = Math.min(page, pages);
      list.replaceChildren();
      if (!filtered.length) list.appendChild(make('div', 'text-center py-5 text-muted small', search.value.trim() ? 'No matching notifications.' : 'No notifications'));
      filtered.slice((page - 1) * pageSize, page * pageSize).forEach(n => {
        const row = make('div', 'notif-modal-item' + (n.read ? '' : ' unread'));
        row.tabIndex = 0;
        row.setAttribute('role', 'link');
        row.setAttribute('aria-label', String(n.title || 'Notification') + (n.read ? '' : ', unread'));
        const checkbox = make('input', 'notif-checkbox');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(n._id);
        checkbox.setAttribute('aria-label', 'Select ' + String(n.title || 'notification'));
        checkbox.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', () => {
          if (busy || loading) return;
          if (checkbox.checked) selected.add(n._id); else selected.delete(n._id);
          updateControls();
        });
        row.appendChild(checkbox);
        if (!n.read) row.appendChild(make('span', 'notif-dot'));
        const icon = make('span', 'notif-icon');
        const positive = /approved|accepted|completed|verified|paid|confirmed/.test(n.type || '');
        const negative = /cancelled|rejected|declined|expired/.test(n.type || '');
        icon.style.background = negative ? '#fee2e2' : positive ? '#dcfce7' : '#dbeafe';
        icon.style.color = negative ? '#dc2626' : positive ? '#16a34a' : '#2563eb';
        icon.appendChild(make('i', 'bi ' + (negative ? 'bi-x-circle' : positive ? 'bi-check-circle' : /assignment/.test(n.type || '') ? 'bi-person-plus' : 'bi-bell')));
        icon.setAttribute('aria-hidden', 'true');
        const content = make('div', 'notif-content');
        content.append(make('div', 'notif-title', n.title || 'Notification'), make('div', 'notif-msg', n.message || ''), make('div', 'notif-time', timeAgo(n.createdAt)));
        row.append(icon, content);
        async function openNotification(event) {
          if (event.target === checkbox || busy || loading) return;
          if (!n.read) {
            const saved = await mutate('/api/notifications/' + encodeURIComponent(n._id) + '/read', 'PUT', undefined, () => { n.read = true; });
            if (!saved) return;
          }
          window.location.href = destination(n.link);
        }
        row.addEventListener('click', openNotification);
        row.addEventListener('keydown', event => {
          if (event.target !== row || event.key !== 'Enter') return;
          event.preventDefault();
          openNotification(event);
        });
        list.appendChild(row);
      });
      pagination.classList.toggle('d-none', pages <= 1);
      pagination.style.display = pages <= 1 ? 'none' : 'flex';
      const numbers = byId('notifPageNumbers');
      numbers.replaceChildren();
      const start = Math.max(1, Math.min(page - 2, pages - 4));
      for (let p = start; p <= Math.min(pages, start + 4); p++) {
        const button = make('button', 'notif-page-btn btn btn-sm ' + (p === page ? 'btn-primary' : 'btn-outline-secondary'), String(p));
        button.type = 'button';
        button.setAttribute('aria-label', 'Page ' + p);
        if (p === page) button.setAttribute('aria-current', 'page');
        button.addEventListener('click', () => { if (!busy && !loading) { page = p; render(); } });
        numbers.appendChild(button);
      }
      updateControls();
    }

    async function loadAll() {
      if (busy) return;
      if (controller) controller.abort();
      const active = new AbortController();
      controller = active;
      loading = true;
      message('Loading notifications…');
      updateControls();
      try {
        const incoming = new Map();
        let pages = 1;
        for (let p = 1; p <= pages; p++) {
          const response = await fetch('/api/notifications?limit=100&page=' + p, { credentials: 'same-origin', cache: 'no-store', signal: active.signal });
          if (!response.ok) throw new Error('Unable to load notifications');
          const data = await response.json();
          if (!Array.isArray(data.notifications) || !Number.isFinite(data.pages) || data.pages < 0) throw new Error('Invalid notification response');
          if (p === 1) pages = Math.max(1, data.pages);
          data.notifications.forEach(n => { if (n._id) incoming.set(n._id, n); });
        }
        if (controller !== active || active.signal.aborted) return;
        notifications = Array.from(incoming.values());
        selected.clear();
        message('');
        render();
      } catch (error) {
        if (controller !== active || active.signal.aborted) return;
        message('Could not load notifications. ', true);
        const retry = make('button', 'btn btn-sm btn-link', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', loadAll);
        status.appendChild(retry);
      } finally {
        if (controller === active) { loading = false; updateControls(); }
      }
    }

    async function mutate(url, method, ids, apply) {
      if (busy || loading) return false;
      busy = true;
      message('Saving…');
      updateControls();
      try {
        const options = { method, credentials: 'same-origin' };
        if (ids) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify({ ids }); }
        const response = await fetch(url, options);
        if (!response.ok) throw new Error('Notification action failed');
        apply();
        selected.clear();
        message('');
        render();
        if (window._technicianRefreshNotifications) await window._technicianRefreshNotifications();
        return true;
      } catch (_) {
        message('Could not update notifications. Please try again.', true);
        return false;
      } finally { busy = false; updateControls(); }
    }

    function open() {
      if (opened) return;
      restoreFocus = document.activeElement;
      previousOverflow = document.body.style.overflow;
      if (window._technicianCloseNotificationPanel) window._technicianCloseNotificationPanel();
      opened = true;
      modal.classList.remove('d-none');
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      search.value = '';
      page = 1;
      search.focus();
      loadAll();
    }

    function close() {
      if (!opened) return;
      opened = false;
      if (controller) controller.abort();
      modal.classList.add('d-none');
      modal.style.display = 'none';
      document.body.style.overflow = previousOverflow;
      if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
    }

    byId('viewAllNotifBtn').addEventListener('click', open);
    byId('closeNotifModal').addEventListener('click', close);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    document.addEventListener('keydown', event => {
      if (!opened) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex="0"]')).filter(el => !el.closest('.d-none'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    });
    search.addEventListener('input', () => { page = 1; render(); });
    selectAll.addEventListener('change', () => {
      if (busy || loading) return;
      visible().slice((page - 1) * pageSize, page * pageSize).forEach(n => { if (selectAll.checked) selected.add(n._id); else selected.delete(n._id); });
      render();
    });
    prev.addEventListener('click', () => { if (page > 1 && !busy && !loading) { page--; render(); } });
    next.addEventListener('click', () => { if (page < Math.ceil(visible().length / pageSize) && !busy && !loading) { page++; render(); } });
    const markAll = () => mutate('/api/notifications/read-all', 'PUT', undefined, () => { notifications.forEach(n => { n.read = true; }); });
    const deleteAll = () => {
      if (busy || loading || !window.confirm('Delete all notifications? This cannot be undone.')) return;
      return mutate('/api/notifications/delete-all', 'DELETE', undefined, () => { notifications = []; });
    };
    byId('markAllReadBtn').addEventListener('click', markAll);
    byId('modalMarkAllRead').addEventListener('click', markAll);
    byId('deleteAllBtn').addEventListener('click', deleteAll);
    byId('modalDeleteAll').addEventListener('click', deleteAll);
    selectedRead.addEventListener('click', () => {
      const ids = Array.from(selected);
      if (ids.length) return mutate('/api/notifications/read', 'PUT', ids, () => { notifications.forEach(n => { if (ids.includes(n._id)) n.read = true; }); });
    });
    selectedDelete.addEventListener('click', () => {
      const ids = Array.from(selected);
      if (busy || loading || !ids.length || !window.confirm('Delete ' + ids.length + ' selected notification(s)?')) return;
      return mutate('/api/notifications/bulk-delete', 'DELETE', ids, () => { notifications = notifications.filter(n => !ids.includes(n._id)); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
