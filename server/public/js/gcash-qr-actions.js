(function () {
  'use strict';

  const validQrUrl = value => value === '/images/gcash-receiver-qr.jpg' ||
    /^\/uploads\/payment-qr\/[a-zA-Z0-9._-]+\.(?:png|jpg|webp)$/.test(String(value || ''));

  function apply(url) {
    const qrUrl = validQrUrl(url) ? url : '';
    document.querySelectorAll('[data-gcash-qr-image]').forEach(image => {
      if (qrUrl) image.src = qrUrl;
      else image.removeAttribute('src');
      image.classList.toggle('d-none', !qrUrl);
    });
    document.querySelectorAll('[data-gcash-qr-download]').forEach(link => {
      if (qrUrl) {
        link.href = qrUrl;
        link.download = `CALIDRO-GCash-QR.${qrUrl.split('.').pop()}`;
      }
      else link.removeAttribute('href');
      link.classList.toggle('d-none', !qrUrl);
    });
    document.querySelectorAll('[data-gcash-qr-label]').forEach(label => label.classList.toggle('d-none', !qrUrl));
    document.querySelectorAll('[data-gcash-qr-missing]').forEach(note => note.classList.toggle('d-none', !!qrUrl));
  }

  window.GcashQrActions = { apply };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply(window.gcashQrImageUrl));
  else apply(window.gcashQrImageUrl);
})();
