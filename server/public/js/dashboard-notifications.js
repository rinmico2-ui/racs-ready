(function() {
  'use strict';
  var body = document.getElementById('notificationsBody');
  var count = document.getElementById('dashboardNotificationCount');
  var refresh = document.getElementById('dashboardNotificationRefresh');
  var viewAll = document.getElementById('dashboardNotificationViewAll');
  if (!body || !count) return;
  var snapshot = null;
  var revision = 0;
  var loading = false;
  var reloadNeeded = false;

  function safeLink(link) {
    var mapped = window._notifRoleSafeLink ? window._notifRoleSafeLink(link) : link;
    if (!mapped) return '';
    try {
      var url = new URL(mapped, window.location.origin);
      if (url.origin === window.location.origin && /^https?:$/.test(url.protocol)) return url.pathname + url.search + url.hash;
    } catch (_) {}
    return '';
  }

  function textElement(tag, text, className) {
    var element = document.createElement(tag);
    element.textContent = text;
    element.className = className || '';
    return element;
  }

  function render(data) {
    snapshot = data;
    body.replaceChildren();
    var notifications = data.notifications.slice(0, 5);
    count.textContent = data.unreadCount + ' unread';
    var badge = document.getElementById('notifBadge');
    if (badge) {
      badge.textContent = data.unreadCount > 999 ? '999+' : String(data.unreadCount);
      badge.classList.toggle('d-none', data.unreadCount === 0);
    }
    if (!notifications.length) {
      body.appendChild(textElement('p', 'You have no notifications yet.', 'dash-empty mb-0'));
      return;
    }
    body.appendChild(textElement('p', 'Latest ' + notifications.length + ' notifications', 'small text-muted mb-2'));
    notifications.forEach(function(notification) {
      var link = safeLink(notification.link);
      var item = document.createElement(link ? 'a' : 'button');
      if (link) item.href = link;
      else item.type = 'button';
      item.className = 'd-block w-100 text-start text-decoration-none border rounded-3 p-3 mb-2';
      item.style.background = notification.read ? '#fff' : '#eff6ff';
      item.style.color = '#334155';
      item.style.overflowWrap = 'anywhere';
      item.appendChild(textElement('strong', notification.title || 'Notification', 'd-block small'));
      if (!notification.read) item.appendChild(textElement('span', 'Unread', 'badge bg-primary my-1'));
      item.appendChild(textElement('span', notification.message || '', 'd-block small text-muted'));
      var date = new Date(notification.createdAt);
      if (!Number.isNaN(date.getTime())) item.appendChild(textElement('time', date.toLocaleString('en-PH', {
        timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }), 'd-block small text-muted mt-1'));
      item.addEventListener('click', async function(event) {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (item.getAttribute('aria-busy') === 'true') return;
        item.setAttribute('aria-busy', 'true');
        try {
          if (!notification.read) {
            var response = await fetch('/api/notifications/' + encodeURIComponent(notification._id) + '/read', {
              method: 'PUT', credentials: 'same-origin',
            });
            if (!response.ok) throw new Error('Could not mark this notification as read. Please try again.');
            notification.read = true;
            data.unreadCount = Math.max(0, data.unreadCount - 1);
            render(data);
            if (window._notifLoadUnreadCount) window._notifLoadUnreadCount();
            if (window._notifLoadNotifications) window._notifLoadNotifications();
          }
          if (link) window.location.href = link;
        } catch (error) {
          count.textContent = error.message;
        } finally { item.setAttribute('aria-busy', 'false'); }
      });
      body.appendChild(item);
    });
  }

  function valid(data) {
    return data && Array.isArray(data.notifications) && Number.isFinite(data.unreadCount);
  }

  async function load() {
    if (loading) { reloadNeeded = true; return; }
    loading = true;
    var request = ++revision;
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 15000);
    body.setAttribute('aria-busy', 'true');
    if (refresh) refresh.disabled = true;
    try {
      var response = await fetch('/api/notifications?limit=15', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Could not load notifications. Tap Refresh to try again.');
      var data = await response.json();
      if (!valid(data)) throw new Error('Could not load notifications. Tap Refresh to try again.');
      if (request === revision) render(data);
    } catch (error) {
      if (request !== revision) return;
      count.textContent = 'Could not load';
      if (!snapshot) body.replaceChildren(textElement('p', 'Could not load notifications. Tap Refresh to try again.', 'text-danger small mb-0'));
      else count.textContent = 'Could not refresh. Try again.';
    } finally {
      clearTimeout(timer);
      loading = false;
      body.setAttribute('aria-busy', 'false');
      if (refresh) refresh.disabled = false;
      if (reloadNeeded) { reloadNeeded = false; load(); }
    }
  }

  if (refresh) refresh.addEventListener('click', load);
  if (viewAll) viewAll.addEventListener('click', function() {
    var button = document.getElementById('viewAllNotifBtn');
    if (button) button.click();
  });
  window.addEventListener('notifications:loaded', function(event) {
    if (!valid(event.detail)) return;
    revision++;
    render(event.detail);
    body.setAttribute('aria-busy', 'false');
  });
  window.addEventListener('notifications:count', function(event) {
    if (snapshot && event.detail.unreadCount !== snapshot.unreadCount) load();
  });
  window.addEventListener('notification:new', load);
  document.addEventListener('visibilitychange', function() { if (!document.hidden) load(); });
  setInterval(function() { if (!document.hidden) load(); }, 30000);
  load();
})();
