(function () {
  'use strict';
  if (window.TechnicianWorkUpdates) return;
  let timer, busy = false, queued = false, boundSocket, mutations = 0, revision = 0;
  const events = ['booking:updated', 'booking:rescheduled', 'assignment:updated', 'assignment:new', 'order:status-change', 'order:assigned', 'project:phase', 'project:team-status', 'project:team_assigned', 'connect'];
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
  // Status requests can emit several socket events before their HTTP response.
  // Hold those events until the mutation settles, then refresh the workspace once.
  function beginMutation() {
    mutations++;
    revision++;
    window.clearTimeout(timer);
    let finished = false;
    return function finishMutation(refreshNeeded = true) {
      if (finished) return;
      finished = true;
      mutations--;
      revision++;
      if (refreshNeeded || queued) schedule();
    };
  }
  window.TechnicianWorkUpdates = { request: schedule, beginMutation, get revision() { return revision; } };
  async function refresh() {
    bindSocket();
    if (document.hidden || busy || mutations) return;
    if (window.Swal?.isVisible?.() || document.querySelector('.modal.show, .pw-modal-overlay')) {
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
