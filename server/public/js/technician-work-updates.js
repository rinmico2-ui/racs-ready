(function () {
  'use strict';
  if (window.TechnicianWorkUpdates) return;
  let timer, busy = false, queued = false, boundSocket, mutations = 0, revision = 0, afterMutation = false;
  const completions = [];
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
    let finished = false, completion;
    return function finishMutation(refreshNeeded = true) {
      if (finished) return completion;
      finished = true;
      mutations--;
      revision++;
      if (refreshNeeded) {
        afterMutation = true;
        completion = new Promise(resolve => completions.push({ revision, resolve }));
      } else completion = Promise.resolve(false);
      if (refreshNeeded || queued) schedule();
      return completion;
    };
  }
  window.TechnicianWorkUpdates = { request: schedule, beginMutation, get revision() { return revision; } };
  async function refresh() {
    bindSocket();
    if (document.hidden || busy || mutations) return;
    // A completed local write must update its background list/detail even
    // while its receipt, route map or success dialog remains open. These
    // refresh callbacks leave independently mounted action forms intact.
    if (!afterMutation && (window.Swal?.isVisible?.() || document.querySelector('.modal.show:not([data-work-refresh-safe]), .pw-modal-overlay:not([data-work-refresh-safe]), dialog[open]:not([data-work-refresh-safe])'))) {
      timer = window.setTimeout(refresh, 500);
      return;
    }
    const update = window._refreshTechnicianWork;
    if (typeof update !== 'function') { timer = window.setTimeout(refresh, 500); return; }
    queued = false;
    afterMutation = false;
    busy = true;
    const refreshedRevision = revision;
    let succeeded = false;
    try { succeeded = (await update()) !== false; }
    catch (error) { console.warn('Technician work refresh failed:', error.message); }
    finally {
      busy = false;
      // A response started before a newer status write cannot acknowledge it.
      if (refreshedRevision === revision) {
        for (let index = completions.length - 1; index >= 0; index--) {
          if (completions[index].revision <= refreshedRevision) completions.splice(index, 1)[0].resolve(succeeded);
        }
      } else if (completions.length) {
        queued = true;
        afterMutation = true;
      }
      if (queued) schedule();
    }
  }
  function start() {
    bindSocket();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    window.addEventListener('focus', schedule);
    window.addEventListener('online', schedule);
    window.setInterval(() => { bindSocket(); if (!document.hidden) schedule(); }, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
