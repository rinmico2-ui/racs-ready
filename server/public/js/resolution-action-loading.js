/* global document, window, queueMicrotask */
(() => {
  'use strict';
  const groups = new Set(), leases = new Map(), buttons = new Map();
  let activation = null, serial = 0;
  const isWriting = () => groups.has('write') || groups.has('network');
  function status() {
    let node = document.getElementById('resolutionActionStatus');
    if (!node) {
      node = document.createElement('div'); node.id = 'resolutionActionStatus'; node.className = 'rc-action-status';
      node.hidden = true; node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite');
      node.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span><div><strong></strong><small>Please wait until this finishes.</small></div>';
      document.body.appendChild(node);
    }
    return node;
  }
  const messages = new Map();
  function refreshStatus() {
    const node = status(), labels = [...messages.values()];
    node.hidden = !labels.length;
    if (labels.length) node.querySelector('strong').textContent = labels.at(-1);
  }
  function hold(node) {
    if (!node) return () => {};
    let lease = leases.get(node);
    if (!lease) { lease = { count: 0, inert: node.inert, busy: node.getAttribute('aria-busy') }; leases.set(node, lease); }
    lease.count++; node.inert = true; node.setAttribute('aria-busy', 'true');
    return () => {
      if (--lease.count) return;
      node.inert = lease.inert;
      if (lease.busy == null) node.removeAttribute('aria-busy'); else node.setAttribute('aria-busy', lease.busy);
      leases.delete(node);
    };
  }
  function triggerFor(args) {
    for (const arg of args) {
      if (arg?.matches?.('button')) return arg;
      const target = arg?.currentTarget || arg?.target;
      const button = target?.closest?.('button'); if (button) return button;
    }
    return activation || document.activeElement?.closest?.('button');
  }
  function holdButton(button, label, preserveContent = false) {
    if (!button) return () => {};
    let lease = buttons.get(button);
    if (!lease) {
      lease = { html: button.innerHTML, disabled: button.disabled, busy: button.getAttribute('aria-busy'),
        preserveContent, loading: button.getAttribute('data-resolution-loading'), labels: [] };
      buttons.set(button, lease);
    }
    const markup = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>' + label;
    const token = { markup }; lease.labels.push(token);
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    // Queue tabs contain live counters. Replacing their HTML removes those
    // nodes during loadQueue and restoring old HTML would lose updated counts.
    if (lease.preserveContent) button.setAttribute('data-resolution-loading', 'preserve');
    else button.innerHTML = markup;
    return () => {
      const owned = button.innerHTML === markup;
      lease.labels = lease.labels.filter(item => item !== token);
      if (lease.labels.length) { if (owned && !lease.preserveContent) button.innerHTML = lease.labels.at(-1).markup; return; }
      // Handlers can deliberately change a button's eligibility or label.
      if (lease.preserveContent) {
        button.disabled = lease.disabled;
        if (lease.loading == null) button.removeAttribute('data-resolution-loading'); else button.setAttribute('data-resolution-loading', lease.loading);
      } else if (owned) { button.innerHTML = lease.html; button.disabled = lease.disabled; }
      if (lease.busy == null) button.removeAttribute('aria-busy'); else button.setAttribute('aria-busy', lease.busy);
      buttons.delete(button);
    };
  }
  function begin(group, label, button, options = {}) {
    if (groups.has(group) || (isWriting() && !options.allowWrite)) return null;
    groups.add(group);
    const release = [];
    if (options.inert !== false) release.push(hold(document.getElementById('resolutionWorkspace')));
    if (group === 'write' || group === 'network' || options.modals) document.querySelectorAll('.rc-modal .modal-content').forEach(node => release.push(hold(node)));
    const restoreButton = holdButton(button, label, options.preserveButtonContent === true);
    if (options.progress !== false) { messages.set(group, label); refreshStatus(); }
    let finished = false;
    return () => {
      if (finished) return; finished = true;
      groups.delete(group); release.reverse().forEach(done => done()); messages.delete(group); refreshStatus();
      restoreButton();
    };
  }
  function wrap(callback, options) {
    return async function (...args) {
      const group = options.group === 'queue' ? `queue:${++serial}` : options.group;
      const done = begin(group, options.label, triggerFor(args), options);
      if (!done) return;
      try { return await callback.apply(this, args); } finally { done(); options.after?.(); }
    };
  }
  function beginNetwork(label) {
    const done = begin('network', label, null);
    if (!done) return null;
    const cancel = window.Swal?.getCancelButton?.(), originalDisabled = cancel?.disabled;
    if (cancel) cancel.disabled = true;
    let finished = false;
    return () => { if (finished) return; finished = true; if (cancel) cancel.disabled = originalDisabled; done(); };
  }
  document.addEventListener('click', event => {
    if (isWriting() && (event.target.closest?.('#resolutionWorkspace, .rc-modal') || event.target.classList?.contains('modal-backdrop'))) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    const button = event.target.closest?.('button'); activation = button;
    queueMicrotask(() => { if (activation === button) activation = null; });
  }, true);
  document.addEventListener('keydown', event => {
    if (isWriting() && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('beforeunload', event => { if (isWriting()) { event.preventDefault(); event.returnValue = ''; } });
  function dialogReady() { messages.delete('order-dialog'); refreshStatus(); }
  window.ResolutionActionLoading = { wrap, beginNetwork, isWriting, dialogReady };
})();
