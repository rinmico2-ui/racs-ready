(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApplianceFieldGuide = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  // Keep navigation separate from the DOM so deferred focus and user intent
  // have the same rules for shared details and independently edited units.
  function createController({ fields, paint, focus, canMove = () => true, schedule = callback => setTimeout(callback, 0) }) {
    let previous = new Map(), enteredComplete = new Map(), intent = 0;
    function refresh(errorKey) {
      const current = fields();
      const required = current.filter(field => field.count !== false);
      const target = current.find(field => field.key === errorKey && !field.complete) || current.find(field => !field.complete) || null;
      previous = new Map(current.map(field => [field.key, field.complete]));
      paint({ fields: current, target, total: required.length, completed: required.filter(field => field.complete).length, errorKey });
      return current;
    }
    function entered(key) { intent++; enteredComplete.set(key, previous.get(key) === true); }
    function interrupt() { intent++; }
    function commit(key, { explicit = false, automatic = false, keyboard = false, trusted = true } = {}) {
      const token = intent, wasComplete = enteredComplete.get(key) ?? previous.get(key);
      schedule(() => {
        const current = refresh(), index = current.findIndex(field => field.key === key);
        if (index < 0 || token !== intent || !trusted || !canMove(key)) return;
        if (!current[index].complete) {
          if (explicit) { refresh(key); focus(current[index], true); }
          return;
        }
        if (!explicit && (!automatic || keyboard || wasComplete)) return;
        const next = current.slice(index + 1).find(field => !field.complete) || current.slice(0, index).find(field => !field.complete) || null;
        focus(next, false);
      });
    }
    return { refresh, entered, interrupt, commit };
  }

  function mount({ host, fields, enabled, nextButton, continueLabel = 'Choose services' }) {
    const panel = host.querySelector('[data-panel="2"]'), hintId = `${host.id}-field-guide-hint`;
    const guide = document.createElement('div');
    guide.className = 'cab-field-guide'; guide.hidden = true;
    guide.innerHTML = `<div role="status" aria-live="polite" aria-atomic="true"><strong data-guide-title></strong><small id="${hintId}" data-guide-progress></small></div><button type="button" data-guide-go>Go to field <span aria-hidden="true">→</span></button>`;
    host.querySelector('[data-details-required]').after(guide);
    let highlighted = null, keyboardField = null, composing = false;
    const visible = input => input && !input.disabled && input.getClientRects().length > 0;
    function currentFields() {
      if (!enabled() || !panel.getClientRects().length) return [];
      return fields().filter(field => field.element && field.element.getClientRects().length && (!field.element.disabled || field.includeDisabled));
    }
    function paint({ fields: current, target, total, completed, errorKey }) {
      guide.hidden = !current.length;
      if (highlighted) {
        highlighted.closest('label, .cab-quantity')?.classList.remove('cab-guide-next');
        const description = (highlighted.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== hintId);
        if (description.length) highlighted.setAttribute('aria-describedby', description.join(' '));
        else highlighted.removeAttribute('aria-describedby');
      }
      highlighted = target?.element || null;
      for (const field of current) {
        field.element.dataset.cabGuideKey = field.key;
        if (field.element.tagName === 'INPUT') field.element.setAttribute('enterkeyhint', 'next');
      }
      if (!current.length) return;
      const title = errorKey ? `Check: ${target?.label || 'appliance details'}` : target ? `Next: ${target.label}` : 'Your appliance details are ready';
      const progress = errorKey ? target?.error || 'Complete this detail before continuing.' : `${completed} of ${total} required details complete${target?.element.tagName === 'INPUT' && target.element.type !== 'number' ? ' · Press Next or Enter when finished' : ''}`;
      const titleNode = guide.querySelector('[data-guide-title]'), progressNode = guide.querySelector('[data-guide-progress]');
      if (titleNode.textContent !== title) titleNode.textContent = title;
      if (progressNode.textContent !== progress) progressNode.textContent = progress;
      guide.classList.toggle('is-ready', !target); guide.classList.toggle('is-error', Boolean(errorKey));
      const button = guide.querySelector('[data-guide-go]');
      button.textContent = target ? 'Go to field →' : `${continueLabel} →`;
      button.setAttribute('aria-label', target ? `Go to ${target.label}` : continueLabel);
      button.disabled = !target && nextButton().disabled;
      if (highlighted) {
        highlighted.closest('label, .cab-quantity')?.classList.add('cab-guide-next');
        highlighted.setAttribute('aria-describedby', [...new Set([...(highlighted.getAttribute('aria-describedby') || '').split(' ').filter(Boolean), hintId])].join(' '));
      }
    }
    function focus(field, validate) {
      const input = field?.element || nextButton();
      if (!visible(input)) return;
      input.focus({ preventScroll: true });
      const rectangle = input.getBoundingClientRect(), footer = host.querySelector('.cab-footer');
      const top = Math.max(85, guide.getBoundingClientRect().bottom + 10);
      const bottom = window.innerHeight - (footer?.getBoundingClientRect().height || 0) - 20;
      if (rectangle.top < top || rectangle.bottom > bottom) input.scrollIntoView({ block: 'center', behavior: 'auto' });
      if (validate) input.reportValidity?.();
    }
    const controller = createController({ fields: currentFields, paint, focus,
      canMove: key => {
        const active = document.activeElement;
        return enabled() && !composing && (!active || active === document.body || active.dataset.cabGuideKey === key);
      },
    });
    const deferredRefresh = () => setTimeout(() => controller.refresh(), 0);
    host.addEventListener('pointerdown', () => { keyboardField = null; controller.interrupt(); }, true);
    host.addEventListener('focusin', event => {
      const key = event.target.dataset?.cabGuideKey;
      if (key) controller.entered(key); else controller.interrupt();
    }, true);
    host.addEventListener('compositionstart', () => { composing = true; controller.interrupt(); }, true);
    host.addEventListener('compositionend', () => { composing = false; deferredRefresh(); }, true);
    host.addEventListener('input', deferredRefresh, true);
    host.addEventListener('click', deferredRefresh, true);
    host.addEventListener('toggle', deferredRefresh, true);
    host.addEventListener('change', event => {
      const input = event.target, key = input.dataset?.cabGuideKey;
      if (key) controller.commit(key, { automatic: input.tagName === 'SELECT', keyboard: keyboardField === key, trusted: event.isTrusted });
      else deferredRefresh();
    }, true);
    host.addEventListener('keydown', event => {
      const input = event.target, key = input.dataset?.cabGuideKey;
      if (!key || !enabled()) return;
      controller.interrupt();
      if (event.isComposing || composing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation(); keyboardField = null;
        controller.commit(key, { explicit: true, trusted: event.isTrusted });
      } else if (input.tagName === 'SELECT') keyboardField = key;
    }, true);
    guide.querySelector('[data-guide-go]').addEventListener('click', () => {
      controller.interrupt();
      const current = controller.refresh(), target = current.find(field => !field.complete);
      if (target) focus(target, false); else if (current.length && !nextButton().disabled) nextButton().click();
    });
    document.addEventListener('shown.bs.tab', deferredRefresh);
    controller.refresh();
    return { refresh: () => controller.refresh() };
  }
  return { createController, mount };
});
