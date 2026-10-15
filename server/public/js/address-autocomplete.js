(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AddressAutocomplete = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function retryDelay(response, data, fallback = 30000) {
    const raw = response?.headers?.get?.('Retry-After');
    const headerDelay = raw == null ? NaN : Number.isFinite(Number(raw)) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
    const delay = Number.isFinite(Number(data?.retryAfter)) && Number(data.retryAfter) > 0 ? Number(data.retryAfter)
      : Number.isFinite(headerDelay) ? headerDelay : fallback;
    return Math.min(300000, Math.max(1000, delay));
  }
  function appendAttribution(container, provider) {
    const doc = container.ownerDocument;
    if (provider === 'psgc') {
      const note = doc.createElement('div'); note.className = 'px-3 py-2 border-top small text-muted bg-white flex-shrink-0';
      const link = doc.createElement('a'); link.href = 'https://psgc.cloud/'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Locality names: PSGC';
      note.append(link); container.append(note); return;
    }
    const note = doc.createElement('div'); note.className = 'px-3 py-2 border-top small text-muted bg-white flex-shrink-0'; note.style.fontSize = '10px';
    const link = doc.createElement('a'); link.href = 'https://www.openstreetmap.org/copyright'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '© OpenStreetMap';
    note.append(link);
    if (!['geoapify','photon'].includes(provider)) { container.append(note); return; }
    note.append(doc.createTextNode(' · '));
    const source = doc.createElement('a'); source.href = provider === 'geoapify' ? 'https://www.geoapify.com/' : 'https://photon.komoot.io/';
    source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = provider === 'geoapify' ? 'Geoapify' : 'Photon';
    note.append(source); container.append(note);
  }
  function create(options, win = window) {
    const { input, list, searchButton, onSelect, onInput, onLocality } = options;
    if (!input || !list) return null;
    if (input._addressAutocomplete) return input._addressAutocomplete;
    const doc = input.ownerDocument || win.document;
    let timer, controller, sequence = 0, rows = [], composing = false, retryAt = 0;
    const originalSearch = searchButton?.innerHTML;
    input.setAttribute('role','combobox'); input.setAttribute('aria-autocomplete','list'); input.setAttribute('aria-controls',list.id);
    input.setAttribute('aria-expanded','false'); input.setAttribute('autocomplete','off');
    list.setAttribute('role','listbox'); list.setAttribute('aria-label','Nueva Ecija address suggestions');
    function close() { list.style.display = 'none'; list.classList.add('d-none'); input.setAttribute('aria-expanded','false'); }
    function open() { list.style.display = 'block'; list.classList.remove('d-none'); input.setAttribute('aria-expanded','true'); }
    function busy(value) {
      input.setAttribute('aria-busy',String(value));
      if (searchButton) { searchButton.disabled = value; searchButton.innerHTML = value ? '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>' : originalSearch; }
    }
    function cancel() { win.clearTimeout(timer); ++sequence; controller?.abort(); busy(false); close(); }
    function message(text, allowSearch = false) {
      rows = []; list.replaceChildren(); const note = doc.createElement('div');
      note.className = 'list-group-item border-0 py-3 small text-secondary'; note.setAttribute('role','status'); note.textContent = text; list.append(note);
      if (allowSearch) {
        const button = doc.createElement('button'); button.type = 'button';
        button.className = 'list-group-item list-group-item-action border-0 py-2 small text-primary text-start';
        button.style.minHeight = '44px'; button.textContent = 'Search this address';
        button.addEventListener('click', event => {
          // lookup replaces this row before the document's outside-click
          // handler runs; keep that same click from cancelling its request.
          event.stopPropagation(); return lookup(true);
        });
        list.append(button); rows.push(button);
      }
      open();
    }
    function select(result) {
      cancel(); input.value = result.display_name;
      if (result.match_level === 'locality') {
        onInput?.(result.display_name);
        if (onLocality) onLocality(result);
        else message('Locality selected. Place the exact house or service pin on the map.');
        return;
      }
      onSelect?.(result);
    }
    function render(results) {
      rows = []; list.replaceChildren();
      results.forEach(result => {
        const lat = Number(result.lat), lon = Number(result.lon);
        const locality = result.match_level === 'locality' && result.source === 'psgc' && result.address?.state === 'Nueva Ecija';
        const covered = win.NuevaEcijaCoverage ? win.NuevaEcijaCoverage.contains(lat, lon) : Number.isFinite(lat) && Number.isFinite(lon) && lat >= 4.5 && lat <= 21.5 && lon >= 116 && lon <= 127;
        if (!result.display_name || !locality && !covered) return;
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'list-group-item list-group-item-action border-0 py-2 small text-start';
        button.setAttribute('role','option'); button.textContent = result.display_name;
        if (locality) {
          const hint = doc.createElement('small'); hint.className = 'd-block text-muted'; hint.textContent = 'City / barangay match · place your exact pin on the map'; button.append(hint);
        }
        button.addEventListener('click',() => select({ ...result,lat:locality?null:lat,lon:locality?null:lon }));
        button.addEventListener('keydown',event => {
          if (event.key === 'Escape') { event.preventDefault(); cancel(); input.focus(); }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); const index = (rows.indexOf(button) + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; rows[index]?.focus();
          }
        });
        rows.push(button); list.append(button);
      });
      if (!rows.length) { message('No matches yet. Try adding the city or province, or place a pin on the map.'); return; }
      appendAttribution(list,results[0]?.source); open();
    }
    async function lookup(explicit = false) {
      win.clearTimeout(timer); const query = input.value.trim();
      if (query.length < 3) { cancel(); return; }
      if (query.length > 250) { cancel(); message('Use a shorter address to search, then add any extra details.'); return; }
      if (!explicit && Date.now() < retryAt) {
        message('Live suggestions are temporarily unavailable. Search this address or place a pin on the map.', true);
        return;
      }
      const token = ++sequence; controller?.abort(); controller = new win.AbortController(); busy(true);
      message('Finding matching addresses…');
      try {
        const endpoint = explicit ? '/api/geocoding/search' : '/api/geocoding/autocomplete';
        const response = await win.fetch(endpoint + '?q=' + encodeURIComponent(query),{ signal:controller.signal,credentials:'same-origin' });
        const data = await response.json().catch(() => null);
        if (token !== sequence || input.value.trim() !== query) return;
        const results = Array.isArray(data) ? data : data?.suggestions;
        if (!response.ok || !Array.isArray(results)) {
          if ([429, 502, 503, 504].includes(response.status) && !data?.localFallbackAvailable) retryAt = Date.now() + retryDelay(response, data);
          const error = new Error('Address lookup failed');
          error.localFallbackAvailable = data?.localFallbackAvailable === true;
          error.userMessage = typeof data?.error === 'string' ? data.error : 'Address search is temporarily unavailable. Search this address or use the map.';
          throw error;
        }
        if (!explicit) retryAt = 0;
        render(results);
      } catch (error) {
        if (error.name === 'AbortError' || token !== sequence || input.value.trim() !== query) return;
        if (!explicit && !error.localFallbackAvailable && retryAt < Date.now()) retryAt = Date.now() + 30000;
        message(error.userMessage || 'Address search is temporarily unavailable. Search this address or use the map.', true);
      } finally { if (token === sequence) busy(false); }
    }
    function typed() {
      cancel(); onInput?.(input.value.trim());
      if (composing || input.value.trim().length < 3) return;
      if (Date.now() < retryAt) {
        message('Live suggestions are temporarily unavailable. Search this address or place a pin on the map.', true);
        return;
      }
      timer = win.setTimeout(lookup,350);
    }
    function keydown(event) {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      else if (event.key === 'ArrowDown' && input.getAttribute('aria-expanded') === 'true' && rows.length) { event.preventDefault(); rows[0].focus(); }
      else if (event.key === 'Enter') { event.preventDefault(); lookup(true); }
    }
    function outside(event) { if (!input.contains(event.target) && !list.contains(event.target) && !searchButton?.contains(event.target)) cancel(); }
    const search = () => lookup(true);
    input.addEventListener('input',typed); input.addEventListener('keydown',keydown);
    input.addEventListener('compositionstart',() => { composing = true; cancel(); });
    input.addEventListener('compositionend',() => { composing = false; typed(); });
    searchButton?.addEventListener('click',search); doc.addEventListener('click',outside);
    const api = { search,close:cancel }; input._addressAutocomplete = api; return api;
  }
  return { create,appendAttribution,retryDelay };
});
