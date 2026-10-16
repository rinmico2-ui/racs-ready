(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./address-autocomplete'));
  else root.RelocationBookingLocations = factory(root.AddressAutocomplete);
})(typeof window === 'object' ? window : globalThis, function (AddressAutocomplete) {
  'use strict';
  function validPoint(place) {
    return place?.lat != null && place?.lng != null && place.lat !== '' && place.lng !== '' && Number(place.lat) >= 4 && Number(place.lat) <= 22 && Number(place.lng) >= 116 && Number(place.lng) <= 127;
  }
  function createController(options) {
    const { document, fetch, getItem, getOrigin, setPin, setTarget, changed } = options;
    const acceptPoint = place => validPoint(place) && (!options.contains || options.contains(Number(place.lat), Number(place.lng)));
    const byId = id => document.getElementById(id);
    const input = byId('relocationDestinationAddress'), list = byId('relocationDestinationSuggest');
    const browser = options.window || (typeof window === 'object' ? window : { document, fetch, AbortController, setTimeout, clearTimeout,
      ...(options.contains ? { NuevaEcijaCoverage: { contains: options.contains } } : {}) });
    let active = null, originKey = '', target = 'from', explicitTarget = false, version = 0, abort, autocomplete;
    let manualAddress = '';
    const status = text => { const node = byId('relocationDestinationStatus'); if (node) node.textContent = text; };
    function cancelPinLookup() { ++version; abort?.abort(); abort = null; }
    function setMapTarget(next, focus = false) {
      target = next; setTarget(next);
      ['From', 'To'].forEach(name => {
        const button = byId('relocationMapStep' + name); if (!button) return;
        const selected = next === name.toLowerCase(); button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('is-active', selected);
      });
      const help = byId('relocationMapStepHelp');
      if (help) help.textContent = next === 'to'
        ? 'Map clicks move the orange pin for the new address. Select Current address to move the green pin.'
        : 'Map clicks move the green pin for the current address. Select New address to move the orange pin.';
      if (focus) {
        const field = next === 'to' ? input : byId('locationInput');
        field?.focus({ preventScroll: true }); field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    function chooseTarget(next, focus = false) {
      if (!['from', 'to'].includes(next) || next === 'to' && !acceptPoint(getOrigin())) return;
      explicitTarget = true;
      if (next === 'from') { cancelPinLookup(); autocomplete?.close(); }
      setMapTarget(next, focus);
    }
    function sync() {
      const item = getItem(), origin = getOrigin(), separate = item?.relocation?.scope === 'different_address' && !item.relocation.requestId;
      byId('relocationMapSteps')?.classList.toggle('d-none', !separate);
      byId('relocationDestinationSection')?.classList.toggle('d-none', !separate);
      if (active !== item) {
        cancelPinLookup(); autocomplete?.close(); active = item; originKey = ''; manualAddress = ''; explicitTarget = false; setMapTarget('from');
      }
      if (!item) return;
      if (acceptPoint(origin) && !item.relocation.requestId) {
        item.relocation.from = { ...(item.relocation.from || {}), address: origin.address || '', lat: Number(origin.lat), lng: Number(origin.lng) };
        if (item.relocation.scope === 'same_property') item.relocation.to = { ...(item.relocation.to || {}), address: origin.address || '', lat: Number(origin.lat), lng: Number(origin.lng) };
      }
      if (!separate || !input) return;
      const ready = acceptPoint(origin), key = ready ? `${origin.lat},${origin.lng}` : '';
      input.disabled = !ready;
      const destinationStep = byId('relocationMapStepTo'); if (destinationStep) destinationStep.disabled = !ready;
      const pinButton = byId('relocationDestinationPin'); if (pinButton) pinButton.disabled = !ready;
      const searchButton = byId('relocationDestinationSearch'); if (searchButton) searchButton.disabled = !ready || input.getAttribute('aria-busy') === 'true';
      if (input.value !== (item.relocation.to?.address || '')) input.value = item.relocation.to?.address || '';
      if (!ready) { cancelPinLookup(); autocomplete?.close(); originKey = ''; setMapTarget('from'); status('Choose the current address first.'); }
      else if (key !== originKey) {
        const firstOrigin = !originKey; originKey = key;
        if (firstOrigin && !explicitTarget) setMapTarget('to');
        if (!acceptPoint(item.relocation.to)) status('Current location saved. Choose the new address or place its orange pin.');
      }
    }
    function apply(point, address, focusMap = false) {
      const item = getItem();
      if (!item || item !== active || !acceptPoint(point) || !acceptPoint(getOrigin())) return false;
      item.relocation.to = { ...(item.relocation.to || {}), address: String(address || '').trim(), lat: Number(point.lat), lng: Number(point.lng) };
      if (input) input.value = item.relocation.to.address;
      setPin(Number(point.lat), Number(point.lng), { focusMap }); changed(); return true;
    }
    function editDestination(address) {
      const item = getItem(); if (item?.relocation?.scope !== 'different_address' || item !== active) return;
      cancelPinLookup(); chooseTarget('to'); manualAddress = address;
      item.relocation.to = { ...(item.relocation.to || {}), address, lat: null, lng: null };
      options.clearPin?.(); changed(); status('Choose an address suggestion or place the orange pin.');
    }
    autocomplete = AddressAutocomplete.create({ input, list, searchButton: byId('relocationDestinationSearch'),
      onInput: editDestination,
      onSelect: result => {
        const point = { lat: result.lat, lng: result.lon ?? result.lng };
        if (!acceptPoint(point)) { status('Choose a new address within Nueva Ecija.'); return; }
        manualAddress = ''; cancelPinLookup(); chooseTarget('to');
        if (apply(point, result.display_name, true)) status('New address found. Check the orange pin and drag it to the exact location if needed.');
      },
      onLocality: result => { autocomplete?.close(); editDestination(result.display_name); status('The address is saved, but its map location could not be found. Place the orange pin at the exact destination.'); },
    }, browser);
    async function pin(lat, lng) {
      const item = getItem();
      if (item?.relocation?.scope !== 'different_address' || item !== active || !acceptPoint({ lat, lng }) || !acceptPoint(getOrigin())) return;
      cancelPinLookup(); autocomplete?.close(); chooseTarget('to'); const token = version;
      const address = manualAddress || `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
      apply({ lat, lng }, address);
      if (manualAddress) { status('Your address and the orange pin are saved. Drag the pin to adjust its position.'); return; }
      status('New location pinned. Finding its address...'); abort = new AbortController();
      try {
        const response = await fetch(`/api/geocoding/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`, { signal: abort.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('Address unavailable');
        const result = await response.json();
        if (token !== version || getItem() !== item) return;
        const found = String(result.display_name || '').trim();
        if (found.length >= 8) { apply({ lat, lng }, found); status('New address updated. The orange pin marks the exact location you chose.'); }
        else status('The orange pin is saved. Enter the full destination address if the street name is missing.');
      } catch (error) { if (token === version && error.name !== 'AbortError') status('The orange pin is saved. Enter the full destination address if needed.'); }
    }
    // The service-address field is replaced when the customer revisits this
    // step. Delegation keeps map targeting attached to the current input.
    document.addEventListener('focusin', event => {
      if (getItem()?.relocation?.scope !== 'different_address') return;
      if (event.target.id === 'locationInput') chooseTarget('from');
      else if (event.target === input) chooseTarget('to');
    });
    byId('relocationMapStepFrom')?.addEventListener('click', () => chooseTarget('from', true));
    byId('relocationMapStepTo')?.addEventListener('click', () => chooseTarget('to', true));
    byId('relocationDestinationPin')?.addEventListener('click', () => {
      chooseTarget('to'); autocomplete?.close(); status('Tap the new location on the map. Further map clicks keep moving the orange pin until you select Current address.');
      byId('technicianMap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return { sync, pin, search: () => autocomplete?.search(), chooseTarget, target: () => target };
  }
  return { validPoint, createController };
});
