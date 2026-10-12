(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelocationWorkOrderMap = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function point(place) {
    const geometry = place?.coordinates?.coordinates;
    const values = [place?.lat ?? geometry?.[1], place?.lng ?? geometry?.[0]];
    if (values.some(value => value == null || String(value).trim() === '')) return null;
    const [lat, lng] = values.map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 4.5 && lat <= 21.5 && lng >= 116 && lng <= 127 ? [lat, lng] : null;
  }

  function samePoint(from, to) {
    return from && to && Math.abs(from[0] - to[0]) < 0.00001 && Math.abs(from[1] - to[1]) < 0.00001;
  }

  function createController({ L, createLayer, fetch, document }) {
    const maps = [];
    let generation = 0;
    const clear = () => { generation++; for (const map of maps.splice(0)) map.remove(); };

    async function render(item, element, status) {
      const current = generation;
      const origin = point(item.from);
      const destination = point(item.to);
      const say = text => { if (current === generation) status.textContent = text; };
      if (!origin && !destination) {
        element.hidden = true;
        say('No map pins were saved for this move. Ask staff to confirm both locations.');
        return;
      }
      if (!L || typeof createLayer !== 'function') {
        element.hidden = true;
        say('The map could not load. Your saved addresses are shown above.');
        return;
      }
      let map;
      try {
        map = L.map(element, { scrollWheelZoom: false, maxZoom: 22 });
        maps.push(map);
        createLayer().addTo(map);
        function marker(position, kind, title, address, details) {
          const icon = L.divIcon({ className: 'rw-map-pin', html: `<span class="rw-map-pin-dot is-${kind}">${kind === 'origin' ? 'A' : kind === 'destination' ? 'B' : 'A/B'}</span>`, iconSize: [38, 38], iconAnchor: [19, 38] });
          // Use text nodes for saved customer text instead of popup HTML.
          const popup = document.createElement('div');
          const heading = document.createElement('strong');
          heading.textContent = title;
          const body = document.createElement('p');
          body.textContent = [address, details].filter(Boolean).join(' · ');
          popup.append(heading, body);
          L.marker(position, { icon, title }).addTo(map).bindPopup(popup);
        }
        if (samePoint(origin, destination)) {
          marker(origin, 'shared', 'Current and new locations', item.from?.address, [item.from?.details, item.to?.details].filter(Boolean).join(' → '));
          map.setView(origin, 18);
          say(item.sameProperty ? 'Same property: both positions use the saved property pin.' : 'Both locations have the same saved map pin. Confirm the locations with staff.');
          return;
        }
        if (origin) marker(origin, 'origin', 'Current location', item.from?.address, item.from?.details);
        if (destination) marker(destination, 'destination', 'New location', item.to?.address, item.to?.details);
        if (!origin || !destination) {
          map.setView(origin || destination, 16);
          say(!destination ? 'Current location shown. The new location needs a saved map pin before a route can be shown.' : 'New location shown. The current location needs a saved map pin before a route can be shown.');
          return;
        }
        map.fitBounds([origin, destination], { padding: [32, 32], maxZoom: 17 });
        say('Checking the road route…');
      } catch {
        element.hidden = true;
        if (map) { map.remove(); const index = maps.indexOf(map); if (index >= 0) maps.splice(index, 1); }
        say('The map could not load. Your saved addresses are shown above.');
        return;
      }
      try {
        const coords = `${origin[1]},${origin[0]};${destination[1]},${destination[0]}`;
        const response = await fetch(`/api/services/osrm-route?coords=${encodeURIComponent(coords)}`, { credentials: 'same-origin' });
        const data = await response.json();
        if (!response.ok) throw new Error('Route unavailable');
        const route = data.routes?.[0];
        const coordinates = route?.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.some(pair => !Array.isArray(pair) || pair.length < 2 || !pair.every(Number.isFinite))) throw new Error('Route unavailable');
        if (current !== generation) return;
        const line = L.polyline(coordinates.map(([lng, lat]) => [lat, lng]), { color: '#2563eb', weight: 5, opacity: 0.9 }).addTo(map);
        map.fitBounds(line.getBounds(), { padding: [32, 32], maxZoom: 17 });
        const km = Number(route.distance) / 1000;
        const minutes = Math.ceil(Number(route.duration) / 60);
        say(Number.isFinite(km) && Number.isFinite(minutes) ? `Road route: ${km.toFixed(1)} km · about ${minutes} min. Travel time may change.` : 'Road route between the saved locations.');
      } catch {
        say('The road route is unavailable right now. Both saved pins are shown; try Refresh.');
      }
    }
    return { render, clear, resize() { for (const map of maps) map.invalidateSize?.({ pan: false }); } };
  }

  return { point, createController };
});
