(function (root) {
  'use strict';
  function clear(form) {
    form.querySelectorAll('[data-server-feedback]').forEach(function (node) { node.remove(); });
    form.querySelectorAll('[data-server-invalid]').forEach(function (input) {
      input.classList.remove('is-invalid'); input.removeAttribute('aria-invalid'); input.removeAttribute('data-server-invalid');
      var described = (input.getAttribute('aria-describedby') || '').split(' ').filter(function (id) { return id && !id.startsWith('server-error-'); });
      if (described.length) input.setAttribute('aria-describedby', described.join(' ')); else input.removeAttribute('aria-describedby');
    });
  }
  function show(form, error, aliases) {
    clear(form); aliases = aliases || {};
    var first;
    Object.keys(error.fields || {}).forEach(function (field) {
      var input = form.elements.namedItem(field) || document.getElementById(aliases[field] || field);
      if (!input || !form.contains(input)) return;
      var message = document.createElement('div'); message.className = 'invalid-feedback d-block'; message.dataset.serverFeedback = 'true';
      message.id = 'server-error-' + (input.id || field); message.textContent = error.fields[field]; message.setAttribute('role', 'alert');
      input.classList.add('is-invalid'); input.setAttribute('aria-invalid', 'true'); input.dataset.serverInvalid = 'true';
      input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), message.id].filter(Boolean).join(' '));
      input.insertAdjacentElement('afterend', message); if (!first) first = input;
    });
    if (!first) {
      var summary = document.createElement('div'); summary.className = 'alert alert-danger'; summary.dataset.serverFeedback = 'true'; summary.setAttribute('role', 'alert'); summary.textContent = error.message || 'Please check the form and try again.'; form.prepend(summary);
    } else first.focus();
  }
  function markRequired() {
    document.querySelectorAll('input[required][id],select[required][id],textarea[required][id]').forEach(function (input) {
      var label = Array.from(document.getElementsByTagName('label')).find(function (node) { return node.htmlFor === input.id; });
      if (!label || label.querySelector('[data-required-indicator]') || label.textContent.includes('*')) return;
      var marker = document.createElement('span'); marker.dataset.requiredIndicator = 'true'; marker.className = 'text-danger'; marker.textContent = ' *'; marker.setAttribute('aria-hidden', 'true'); label.appendChild(marker);
    });
  }
  root.FormFeedback = { clear: clear, show: show, markRequired: markRequired };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markRequired); else markRequired();
})(window);
