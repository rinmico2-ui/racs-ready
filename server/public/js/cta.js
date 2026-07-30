// CTA helper: unobtrusive event emission for analytics and tracking
(function () {
  function trackClick(payload) {
    // Push to dataLayer if available (Google Tag Manager friendly)
    if (window.dataLayer) {
      window.dataLayer.push(payload);
    }

    // Non-blocking beacon to backend if/when available
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/collect', body);
      } else {
        fetch('/collect', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: body }).catch(function () {});
      }
    } catch (e) {
      // swallow — analytics should never break UX
      console.debug('CTA track failed', e);
    }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-cta]');
    if (!btn) return;

    var label = btn.dataset.label || btn.getAttribute('href') || 'cta';
    var payload = {
      event: 'cta_click',
      label: label,
      cta: btn.dataset.cta || 'unknown',
      page: window.location.pathname,
      ts: Date.now()
    };

    trackClick(payload);
  }, false);
})();