(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CustomerWorkflowRefresh = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function bindWorkflowRefresh({ window: win, document: doc, socket, refresh, isBusy = () => false, pollIntervalMs = 60000 }) {
    let timer = null, running = false, pending = false, stopped = false;
    const busy = () => isBusy() || Boolean(doc.querySelector('.modal.show')) || Boolean(win.Swal?.isVisible?.());
    function schedule() {
      if (stopped) return;
      pending = true;
      if (timer !== null || running || doc.hidden) return;
      timer = win.setTimeout(run, 400);
    }
    async function run() {
      timer = null;
      if (stopped || doc.hidden) return;
      if (busy()) { schedule(); return; }
      pending = false;
      running = true;
      try { await refresh(); }
      catch (error) { win.console?.warn('Could not refresh your latest status:', error.message); }
      finally { running = false; if (pending) schedule(); }
    }
    const events = ['booking:status-change', 'booking:auto-reschedule-pending', 'order:status-change', 'notification:new', 'connect'];
    events.forEach(event => socket?.on(event, schedule));
    const visible = () => { if (!doc.hidden) schedule(); };
    doc.addEventListener('visibilitychange', visible);
    win.addEventListener('notification:new', schedule);
    win.addEventListener('focus', visible);
    win.addEventListener('online', visible);
    // Recover missed events after a disconnected socket, and show staff changes
    // that do not yet have a dedicated event. Hidden tabs do not fetch.
    const poll = win.setInterval(schedule, Math.max(1000, Number(pollIntervalMs) || 60000));
    function stop() {
      stopped = true;
      if (timer !== null) win.clearTimeout(timer);
      win.clearInterval(poll);
      events.forEach(event => socket?.off?.(event, schedule));
      doc.removeEventListener('visibilitychange', visible);
      win.removeEventListener?.('notification:new', schedule);
      win.removeEventListener?.('focus', visible);
      win.removeEventListener?.('online', visible);
    }
    win.addEventListener('pagehide', stop, { once: true });
    win.addEventListener('pageshow', event => { if (event.persisted) win.location.reload(); });
    return { schedule, stop };
  }
  return { bindWorkflowRefresh };
});
