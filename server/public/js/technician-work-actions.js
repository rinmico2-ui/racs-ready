(function () {
  'use strict';
  if (window.TechnicianWorkActions) return;
  const actions = ['transitionStatus', 'repairTransition', 'repairEnRoute', 'updateMixedCoreItemStatus',
    'startAllCoreWork', 'completeAllCoreWork', 'startMixedRepairInspection', 'doStatus'];
  const controls = [...actions, 'openCollectPaymentModal', 'openCustomerNotAvailable', 'openCancelModal',
    'openInspectionModal', 'openRepairUnits', 'openRepairWorkflow', 'startRepair', 'completeRepair', 'acceptAssign', 'declineAssign'];
  const selector = controls.map(name => '[onclick*="' + name + '("]').join(',')
    + ',#detailPanelActions button:not([onclick*="openRouteMapModal"]):not([onclick*="switchDetailTab"]),[data-action="status"]';
  let busy = false, observer;
  const disabled = new Map();
  function lockControls() {
    document.querySelectorAll(selector).forEach(button => {
      if (!disabled.has(button)) disabled.set(button, button.disabled);
      button.disabled = true;
    });
    const bar = document.getElementById('detailPanelActions');
    if (bar) {
      bar.setAttribute('aria-busy', 'true');
      if (!document.getElementById('technicianWorkSaving')) {
        const message = document.createElement('span');
        message.id = 'technicianWorkSaving'; message.className = 'small text-primary fw-semibold';
        message.setAttribute('role', 'status'); message.textContent = 'Updating this visit...';
        bar.append(message);
      }
    }
  }
  async function run(work) {
    if (busy) return false;
    busy = true;
    lockControls();
    observer = new MutationObserver(lockControls);
    observer.observe(document.body, { childList: true, subtree: true });
    try { return await work(); }
    finally {
      observer.disconnect(); observer = null;
      disabled.forEach((wasDisabled, button) => { if (button.isConnected) button.disabled = wasDisabled; });
      disabled.clear(); busy = false;
      document.getElementById('detailPanelActions')?.removeAttribute('aria-busy');
      document.getElementById('technicianWorkSaving')?.remove();
    }
  }
  actions.forEach(name => {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function (...args) { return run(() => original.apply(this, args)); };
  });
  // Capture clicks as well as direct function calls. Newly rendered controls
  // cannot start a second mutation before the observer has disabled them.
  document.addEventListener('click', event => {
    if (busy && event.target.closest?.(selector)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.TechnicianWorkActions = { run, get busy() { return busy; } };
})();
