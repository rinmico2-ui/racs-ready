(function () {
  'use strict';
  let timer, busy = false, queued = false, boundSocket;
  const events = ['booking:updated', 'booking:rescheduled', 'assignment:updated', 'assignment:new', 'order:status-change', 'order:assigned', 'connect'];
  function bindSocket() {
    if (!window.socket || boundSocket === window.socket) return;
    if (boundSocket) events.forEach(event => boundSocket.off(event, schedule));
    boundSocket = window.socket;
    events.forEach(event => boundSocket.on(event, schedule));
  }
  function schedule() {
    queued = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(refresh, 250);
  }
  async function refresh() {
    bindSocket();
    if (document.hidden || busy) return;
    if (window.Swal?.isVisible?.() || document.querySelector('.modal.show')) {
      timer = window.setTimeout(refresh, 500);
      return;
    }
    const update = window._refreshTechnicianWork;
    if (typeof update !== 'function') return;
    queued = false;
    busy = true;
    try { await update(); }
    catch (error) { console.warn('Technician work refresh failed:', error.message); }
    finally { busy = false; if (queued) schedule(); }
  }
  function start() {
    bindSocket();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    window.addEventListener('focus', schedule);
    window.setInterval(() => { bindSocket(); if (!document.hidden) schedule(); }, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
