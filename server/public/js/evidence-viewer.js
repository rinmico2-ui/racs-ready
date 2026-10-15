(function () {
  'use strict';
  const viewers = new WeakMap();
  function safeSource(value) {
    const source = String(value || '').trim();
    if (/^data:(?:image\/(?:png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+/=\r\n]+$/i.test(source)) return source;
    try {
      const url = new URL(source, window.location.href);
      if (!source || !/^https?:$/.test(url.protocol)) return '';
      if (url.origin === window.location.origin && /^\/(?:uploads|api)\//.test(url.pathname)) return url.pathname + url.search;
      if (url.protocol === 'https:' && url.hostname === 'res.cloudinary.com') return url.href;
    } catch (_) {}
    return '';
  }
  function clear(container) {
    const old = viewers.get(container);
    if (old) { clearTimeout(old.timer); old.controller.abort(); if (old.objectUrl) URL.revokeObjectURL(old.objectUrl); }
    viewers.delete(container);
    container.replaceChildren();
  }
  async function show(container, value, options = {}) {
    clear(container);
    const source = safeSource(value);
    const status = document.createElement('div');
    status.className = 'small text-muted py-2';
    status.setAttribute('role', 'status');
    status.textContent = value ? 'Loading receipt…' : 'No receipt attached.';
    container.appendChild(status);
    if (!value) return;
    if (!source) { status.textContent = 'This receipt is not a supported photo or PDF.'; return; }
    const state = { controller: new AbortController(), objectUrl: null };
    state.timer = setTimeout(() => { state.timedOut = true; state.controller.abort(); }, 15000);
    viewers.set(container, state);
    try {
      let src = source;
      let pdf = /\.pdf(?:[?#]|$)/i.test(source) || /^data:application\/pdf/i.test(source);
      if (source.startsWith('/') || source.startsWith('data:')) {
        const response = await fetch(source, { credentials: 'same-origin', cache: 'no-store', signal: state.controller.signal });
        if (!response.ok) throw Object.assign(new Error('Receipt unavailable'), { status: response.status });
        const file = await response.blob();
        if (!/^image\/(png|jpeg|webp)$/i.test(file.type) && file.type !== 'application/pdf') throw Object.assign(new Error('Unsupported receipt'), { status: 415 });
        pdf = file.type === 'application/pdf';
        src = state.objectUrl = URL.createObjectURL(file);
      }
      if (viewers.get(container) !== state || state.controller.signal.aborted) return;
      const preview = document.createElement(pdf ? 'iframe' : 'img');
      preview.src = src;
      preview.title = 'Receipt preview';
      preview.alt = 'Uploaded receipt';
      preview.style.cssText = pdf ? 'width:100%;height:480px;border:1px solid #e2e8f0;border-radius:10px;' : 'display:block;width:100%;max-height:480px;object-fit:contain;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;';
      preview.addEventListener('error', () => { status.textContent = 'The receipt could not be displayed. Try opening the file below.'; });
      const link = document.createElement('a');
      link.href = source.startsWith('data:') ? src : source;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'btn btn-sm btn-outline-primary mt-2';
      link.textContent = pdf ? 'Open PDF' : 'Open full photo';
      status.textContent = '';
      container.append(preview, link);
    } catch (error) {
      if ((state.controller.signal.aborted && !state.timedOut) || viewers.get(container) !== state) return;
      status.textContent = state.timedOut ? 'The receipt is taking too long to load. Please try again.' : error.status === 404
        ? 'The saved receipt is missing from the server. Ask the person who submitted it to provide the original file.'
        : error.status === 401 ? 'Your session has expired. Sign in again to view the receipt.'
          : error.status === 403 ? 'You do not have permission to view this receipt.'
            : error.status === 415 ? 'This receipt could not be displayed as a supported photo or PDF.'
              : 'The receipt could not be loaded right now. Check your connection and try again.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-sm btn-outline-secondary mt-2';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => show(container, value, options));
      container.appendChild(retry);
      if (error.status === 404 && typeof options.onMissing === 'function') options.onMissing();
    } finally { clearTimeout(state.timer); }
  }
  window.evidenceViewer = { show, clear, safeSource };
})();
