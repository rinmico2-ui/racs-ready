(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AddressAutocomplete = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function appendAttribution(container, provider) {
    const doc = container.ownerDocument;
    const note = doc.createElement('div'); note.className = 'px-3 py-2 border-top small text-muted'; note.style.fontSize = '10px';
    const link = doc.createElement('a'); link.href = 'https://www.openstreetmap.org/copyright'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '© OpenStreetMap';
    note.append(link);
    if (!['geoapify','photon'].includes(provider)) { container.append(note); return; }
    note.append(doc.createTextNode(' · '));
    const source = doc.createElement('a'); source.href = provider === 'geoapify' ? 'https://www.geoapify.com/' : 'https://photon.komoot.io/';
    source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = provider === 'geoapify' ? 'Geoapify' : 'Photon';
    note.append(source); container.append(note);
  }
  function create(options, win = window) {
    const { input, list, searchButton, onSelect, onInput } = options;
    if (!input || !list) return null;
    if (input._addressAutocomplete) return input._addressAutocomplete;
    const doc = input.ownerDocument || win.document;
    let timer, controller, sequence = 0, rows = [], composing = false, retryAt = 0;
    const originalSearch = searchButton?.innerHTML;
    input.setAttribute('role','combobox'); input.setAttribute('aria-autocomplete','list'); input.setAttribute('aria-controls',list.id);
    input.setAttribute('aria-expanded','false'); input.setAttribute('autocomplete','off');
    list.setAttribute('role','listbox'); list.setAttribute('aria-label','Philippine address suggestions');
    function close() { list.style.display = 'none'; list.classList.add('d-none'); input.setAttribute('aria-expanded','false'); }
    function open() { list.style.display = 'block'; list.classList.remove('d-none'); input.setAttribute('aria-expanded','true'); }
    function busy(value) {
      input.setAttribute('aria-busy',String(value));
      if (searchButton) { searchButton.disabled = value; searchButton.innerHTML = value ? '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>' : originalSearch; }
    }
    function cancel() { win.clearTimeout(timer); ++sequence; controller?.abort(); busy(false); close(); }
    function message(text) {
      rows = []; list.replaceChildren(); const note = doc.createElement('div');
      note.className = 'list-group-item border-0 py-3 small text-secondary'; note.setAttribute('role','status'); note.textContent = text; list.append(note); open();
    }
    function select(result) { cancel(); input.value = result.display_name; onSelect?.(result); }
    function render(results) {
      rows = []; list.replaceChildren();
      results.forEach(result => {
        const lat = Number(result.lat), lon = Number(result.lon);
        if (!result.display_name || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < 4.5 || lat > 21.5 || lon < 116 || lon > 127) return;
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'list-group-item list-group-item-action border-0 py-2 small text-start';
        button.setAttribute('role','option'); button.textContent = result.display_name;
        button.addEventListener('click',() => select({ ...result,lat,lon }));
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
      const token = ++sequence; controller?.abort(); controller = new win.AbortController(); busy(true);
      message('Finding matching addresses…');
      try {
        const endpoint = explicit ? '/api/geocoding/search' : '/api/geocoding/autocomplete';
        const response = await win.fetch(endpoint + '?q=' + encodeURIComponent(query),{ signal:controller.signal,credentials:'same-origin' });
        const data = await response.json().catch(() => null);
        if (token !== sequence || input.value.trim() !== query) return;
        const results = Array.isArray(data) ? data : data?.suggestions;
        if (!response.ok || !Array.isArray(results)) {
          if (response.status === 429 || response.status === 503) retryAt = Date.now() + 3000;
          throw new Error(data?.error || 'Address suggestions are unavailable. Try Search again or use the map.');
        }
        render(results);
      } catch (error) {
        if (error.name === 'AbortError' || token !== sequence || input.value.trim() !== query) return;
        message(error.message || 'Address search is unavailable. Try again or use the map.');
      } finally { if (token === sequence) busy(false); }
    }
    function typed() {
      cancel(); onInput?.(input.value.trim());
      if (composing || input.value.trim().length < 3) return;
      timer = win.setTimeout(lookup,Math.max(350,retryAt - Date.now()));
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
  return { create,appendAttribution };
});
