(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ResolutionEvidence = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  let controller = null;
  let preview = null;

  function normalizePhotos(photos, baseUrl) {
    const seen = new Set();
    return (Array.isArray(photos) ? photos : []).flatMap(photo => {
      if (typeof photo?.src !== 'string') return [];
      const src = photo.src.trim();
      if (!src || seen.has(src)) return [];
      if (src.startsWith('data:')) {
        if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(src)) return [];
      } else {
        try {
          const url = new URL(src, baseUrl);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
        } catch (_) { return []; }
      }
      seen.add(src);
      return [{ src, label: String(photo.label || 'Proof photo') }];
    });
  }

  function cancel() {
    controller?.abort();
    controller = null;
    if (preview?.open) preview.close();
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function showPreview(host, photo, trigger) {
    if (preview?.open) preview.close();
    const dialog = node('dialog', 'rc-evidence-preview');
    const heading = node('h2', '', photo.label);
    heading.id = 'rcEvidencePreviewTitle';
    dialog.setAttribute('aria-labelledby', heading.id);
    const header = node('div', 'rc-evidence-preview-header');
    const close = node('button', 'btn btn-outline-secondary', 'Back to details');
    close.type = 'button'; close.addEventListener('click', () => dialog.close());
    header.append(heading, close);
    const image = node('img', 'rc-evidence-full-image');
    image.alt = photo.label; image.src = photo.src; image.referrerPolicy = 'no-referrer';
    const error = node('p', 'rc-evidence-message', 'This photo could not be loaded. Close the preview and try loading the evidence again.');
    error.hidden = true;
    image.addEventListener('error', () => { image.hidden = true; error.hidden = false; });
    dialog.append(header, image, error);
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (preview === dialog) preview = null;
      if (trigger.isConnected) trigger.focus();
    });
    host.append(dialog);
    preview = dialog;
    dialog.showModal();
  }

  async function mount(host, endpoint) {
    if (!host) return;
    cancel();
    const request = new AbortController(); controller = request;
    host.replaceChildren();
    const header = node('div', 'rc-evidence-heading');
    header.append(node('h3', '', 'Proofs & receipts'), node('p', '', 'Select a photo to inspect it in full size.'));
    const content = node('div', 'rc-evidence-content');
    content.setAttribute('aria-live', 'polite');
    content.append(node('p', 'rc-evidence-message', 'Loading proof photos and receipts…'));
    host.append(header, content);
    try {
      const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: request.signal, headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error('Could not load proof photos and receipts.');
      if (request.signal.aborted || !host.isConnected) return;
      const photos = normalizePhotos(data.photos, window.location.href);
      content.replaceChildren();
      if (!photos.length) {
        content.append(node('p', 'rc-evidence-message', 'No proof photos or receipts have been uploaded for this record.'));
        return;
      }
      const grid = node('div', 'rc-evidence-grid');
      for (const photo of photos) {
        const card = node('button', 'rc-evidence-card');
        card.type = 'button'; card.setAttribute('aria-label', `Enlarge ${photo.label}`);
        const image = node('img', '');
        image.alt = photo.label; image.src = photo.src; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
        const label = node('span', 'rc-evidence-label', photo.label);
        const state = node('span', 'rc-evidence-hint', 'View full size');
        image.addEventListener('error', () => {
          image.hidden = true; card.disabled = true; state.textContent = 'Photo unavailable';
        });
        card.append(image, label, state);
        card.addEventListener('click', () => showPreview(host, photo, card));
        grid.append(card);
      }
      content.append(grid);
    } catch (error) {
      if (request.signal.aborted || !host.isConnected) return;
      content.replaceChildren(node('p', 'rc-evidence-message', 'Could not load proof photos and receipts. Please try again.'));
      const retry = node('button', 'btn btn-outline-primary', 'Try loading photos again');
      retry.type = 'button'; retry.addEventListener('click', () => mount(host, endpoint)); content.append(retry);
    }
  }
  return { mount, cancel, normalizePhotos };
});
