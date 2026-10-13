(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelocationBookingLocations = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function validPoint(place) {
    return place?.lat != null && place?.lng != null && place.lat !== '' && place.lng !== '' && Number(place.lat) >= 4 && Number(place.lat) <= 22 && Number(place.lng) >= 116 && Number(place.lng) <= 127;
  }
  function createController(options) {
    const { document, fetch, getItem, getOrigin, setPin, setTarget, changed } = options;
    const byId = id => document.getElementById(id);
    const input = byId('relocationDestinationAddress'), list = byId('relocationDestinationSuggest');
    let active = null, originKey = '', target = 'from', version = 0, abort, timer;
    const status = text => { const node = byId('relocationDestinationStatus'); if (node) node.textContent = text; };
    function cancel() { ++version; clearTimeout(timer); abort?.abort(); abort = null; }
    function close() { if (list) { list.replaceChildren(); list.classList.add('d-none'); } input?.setAttribute('aria-expanded', 'false'); }
    function chooseTarget(next, focus = false) {
      if (next === 'to' && !validPoint(getOrigin())) return;
      target = next; setTarget(next);
      ['From', 'To'].forEach(name => {
        const button = byId('relocationMapStep' + name); if (!button) return;
        const selected = next === name.toLowerCase(); button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('is-active', selected);
      });
      const help = byId('relocationMapStepHelp');
      if (help) help.textContent = next === 'to' ? 'Now choose the new address or tap the map. The orange pin marks the destination.' : 'Choose the current address or tap the map. The green pin marks the starting point.';
      if (focus) { const field = next === 'to' ? input : byId('locationInput'); field?.focus({ preventScroll: true }); field?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    function sync() {
      const item = getItem(), origin = getOrigin(), custom = item?.relocation?.scope === 'custom_quote' && !item.relocation.requestId;
      byId('relocationMapSteps')?.classList.toggle('d-none', !custom);
      byId('relocationDestinationSection')?.classList.toggle('d-none', !custom);
      if (active !== item) { cancel(); close(); active = item; originKey = ''; chooseTarget('from'); }
      if (!item) return;
      if (validPoint(origin) && !item.relocation.requestId) {
        item.relocation.from = { ...(item.relocation.from || {}), address: origin.address || '', lat: Number(origin.lat), lng: Number(origin.lng) };
        if (item.relocation.scope === 'same_property') item.relocation.to = { ...(item.relocation.to || {}), address: origin.address || '', lat: Number(origin.lat), lng: Number(origin.lng) };
      }
      if (!custom || !input) return;
      const ready = validPoint(origin), key = ready ? `${origin.lat},${origin.lng}` : '';
      input.disabled = !ready;
      const destinationStep = byId('relocationMapStepTo'); if (destinationStep) destinationStep.disabled = !ready;
      ['relocationDestinationPin', 'relocationDestinationSearch'].forEach(id => { const button = byId(id); if (button) button.disabled = !ready; });
      if (input.value !== (item.relocation.to?.address || '')) input.value = item.relocation.to?.address || '';
      if (!ready) { cancel(); originKey = ''; chooseTarget('from'); status('Choose the current address first.'); close(); }
      else if (key !== originKey) {
        originKey = key; chooseTarget('to');
        if (!validPoint(item.relocation.to)) {
          status('Current location saved. Choose the new address or place its orange pin.');
          if (options.isLocationStep?.() && document.activeElement === byId('locationInput')) chooseTarget('to', true);
        }
      }
    }
    function apply(point, address) {
      const item = getItem();
      if (!item || item !== active || !validPoint(point) || !validPoint(getOrigin())) return false;
      item.relocation.to = { ...(item.relocation.to || {}), address: String(address || '').trim(), lat: Number(point.lat), lng: Number(point.lng) };
      if (input) input.value = item.relocation.to.address;
      setPin(Number(point.lat), Number(point.lng)); close(); changed(); return true;
    }
    async function pin(lat, lng) {
      const item = getItem(); if (item?.relocation?.scope !== 'custom_quote' || item !== active || !validPoint({ lat, lng }) || !validPoint(getOrigin())) return;
      cancel(); close(); const token = version, typed = input?.value.trim() || '';
      const address = typed || `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
      apply({ lat, lng }, address); chooseTarget('to');
      if (typed) return;
      status('New location pinned. Finding its address...');
      abort = new AbortController();
      try {
        const response = await fetch(`/api/geocoding/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`, { signal: abort.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('Address unavailable');
        const result = await response.json();
        if (token !== version || getItem() !== item) return;
        const found = String(result.display_name || '').trim();
        if (found.length >= 8) apply({ lat, lng }, found);
        else status('The orange pin is saved. Enter the full destination address if the street name is missing.');
      } catch (error) { if (token === version && error.name !== 'AbortError') status('The orange pin is saved. Enter the full destination address if needed.'); }
    }
    async function search() {
      cancel(); close(); const item = getItem(), query = input?.value.trim() || '', token = version;
      if (item?.relocation?.scope !== 'custom_quote' || item !== active || !validPoint(getOrigin()) || query.length < 3) return;
      abort = new AbortController(); status('Finding address suggestions...');
      try {
        const response = await fetch(`/api/geocoding/search?q=${encodeURIComponent(query)}&limit=5`, { signal: abort.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('Address search unavailable');
        const result = await response.json();
        if (token !== version || getItem() !== item || input.value.trim() !== query) return;
        const rows = Array.isArray(result) ? result.filter(row => validPoint({ lat: row.lat, lng: row.lon })) : [];
        if (!rows.length) { status('No address match. Keep typing or place the orange pin on the map.'); return; }
        rows.forEach(row => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'list-group-item list-group-item-action'; button.setAttribute('role', 'option'); button.textContent = row.display_name;
          button.addEventListener('click', () => { cancel(); apply({ lat: row.lat, lng: row.lon }, row.display_name); chooseTarget('to'); input.focus({ preventScroll: true }); });
          list?.appendChild(button);
        });
        list?.classList.remove('d-none'); input.setAttribute('aria-expanded', 'true'); status('Choose the matching address to set the orange pin.');
      } catch (error) { if (token === version && error.name !== 'AbortError') status('Address search is unavailable. Place the orange pin on the map.'); }
    }
    input?.addEventListener('input', () => {
      const item = getItem(); if (!item || item !== active) return;
      cancel(); close(); chooseTarget('to');
      item.relocation.to = { ...(item.relocation.to || {}), address: input.value.trim(), lat: null, lng: null };
      options.clearPin?.(); changed(); status('Choose an address suggestion or place the orange pin.');
      if (input.value.trim().length >= 3) timer = setTimeout(search, 350);
    });
    input?.addEventListener('focus', () => { if (getItem()?.relocation?.scope === 'custom_quote') chooseTarget('to'); });
    input?.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); search(); }
      if (event.key === 'Escape') { cancel(); close(); }
      if (event.key === 'ArrowDown' && list?.firstElementChild) { event.preventDefault(); list.firstElementChild.focus(); }
    });
    list?.addEventListener('keydown', event => {
      const buttons = [...list.querySelectorAll('button')], index = buttons.indexOf(event.target);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
      if (event.key === 'Escape') { close(); input.focus(); }
    });
    byId('locationInput')?.addEventListener('focus', () => { if (getItem()?.relocation?.scope === 'custom_quote') chooseTarget('from'); });
    byId('relocationMapStepFrom')?.addEventListener('click', () => chooseTarget('from', true));
    byId('relocationMapStepTo')?.addEventListener('click', () => chooseTarget('to', true));
    byId('relocationDestinationSearch')?.addEventListener('click', search);
    byId('relocationDestinationPin')?.addEventListener('click', () => { chooseTarget('to'); status('Tap the new location on the map. You can drag the orange pin afterward.'); byId('technicianMap')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    document.addEventListener('click', event => { if (event.target !== input && !list?.contains(event.target) && !byId('relocationDestinationSearch')?.contains(event.target)) { if (!byId('technicianMap')?.contains(event.target)) cancel(); close(); } });
    return { sync, pin, search, chooseTarget, target: () => target };
  }
  return { validPoint, createController };
});
