(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrderRouteMap = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function point(value) {
    if (!value || value.lat === '' || value.lng === '' || value.lat == null || value.lng == null) return null;
    const lat = Number(value.lat), lng = Number(value.lng);
    return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180 ? { lat, lng } : null;
  }
  function clear(map, layer) {
    if (map && layer && map.hasLayer(layer)) map.removeLayer(layer);
  }
  function draw(options) {
    const { map, leaflet, previousLayer, quote } = options;
    clear(map, previousLayer);
    if (!map || !leaflet) return null;
    const origin = point(quote.origin || options.origin);
    const destination = point(quote.destination || options.destination);
    const geometry = quote.geometry;
    const road = quote.source === 'road' && geometry?.type === 'LineString' &&
      Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2 &&
      geometry.coordinates.every(p => Array.isArray(p) && !!point({ lng:p[0], lat:p[1] }));
    if (!road && (!origin || !destination)) return null;
    const line = road ? geometry : { type:'LineString', coordinates:[[origin.lng,origin.lat],[destination.lng,destination.lat]] };
    const layer = leaflet.geoJSON(line, { interactive:false, style:{ color:road?'#2563eb':'#64748b', weight:5, opacity:.9, dashArray:road?null:'8 8', lineCap:'round' } }).addTo(map);
    const bounds = layer.getBounds();
    if (origin) bounds.extend([origin.lat,origin.lng]);
    if (destination) bounds.extend([destination.lat,destination.lng]);
    if (bounds.isValid()) map.fitBounds(bounds, { padding:[40,40], maxZoom:16, animate:false });
    return layer;
  }
  return { point, clear, draw };
});
