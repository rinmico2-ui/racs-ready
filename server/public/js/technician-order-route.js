(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TechnicianOrderRoute = api;
})(typeof window === 'undefined' ? globalThis : window, function (win) {
  'use strict';
  let dialog, map, route, originMarker, watcher = null, controller, current, generation = 0, lastRouteAt = 0;
  function point(value) {
    if (!value || value.lat == null || value.lng == null || value.lat === '' || value.lng === '') return null;
    const lat = Number(value.lat), lng = Number(value.lng);
    return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180 ? {lat,lng} : null;
  }
  function destinationFor(order) {
    const value = order?.delivery?.coordinates, coords = Array.isArray(value) ? value : value?.coordinates;
    return point(value) || (Array.isArray(coords) && coords.length === 2 ? point({lng:coords[0],lat:coords[1]}) : null);
  }
  function directionsFor(order, origin) {
    const destination = destinationFor(order), address = String(order?.delivery?.address || '').trim();
    if (!destination && !address) return null;
    const params = new URLSearchParams({api:'1',destination:destination ? `${destination.lat},${destination.lng}` : address,travelmode:'driving'});
    if (point(origin)) params.set('origin', `${origin.lat},${origin.lng}`);
    return 'https://www.google.com/maps/dir/?' + params;
  }
  const element = name => dialog.querySelector(`[data-route-${name}]`);
  function cleanup() {
    generation++;
    controller?.abort(); controller = null;
    if (watcher !== null) win.navigator?.geolocation?.clearWatch(watcher);
    watcher = null;
    map?.remove(); map = null; route = null; originMarker = null;
  }
  function close() { cleanup(); current = null; if (dialog?.open) dialog.close(); }
  function mount() {
    if (dialog) return;
    dialog = win.document.createElement('dialog');
    dialog.className = 'technician-order-route';
    dialog.setAttribute('data-work-refresh-safe', '');
    dialog.setAttribute('aria-labelledby', 'technicianOrderRouteTitle');
    dialog.innerHTML = '<header class="tor-header"><div><span class="tor-eyebrow" data-route-reference></span><h2 id="technicianOrderRouteTitle">Route to customer</h2><p data-route-customer></p></div><button type="button" class="tor-close" data-route-close aria-label="Close route map">&times;</button></header><div class="tor-summary"><strong data-route-distance>Loading route...</strong><span data-route-duration></span></div><div class="tor-map" data-route-map aria-label="Customer delivery route map"></div><div class="tor-details"><strong data-route-address></strong><p data-route-status role="status"></p><p class="tor-origin" data-route-origin></p></div><footer class="tor-footer"><button type="button" data-route-close>Close map</button><a data-route-directions target="_blank" rel="noopener noreferrer">Open directions</a></footer>';
    dialog.querySelectorAll('[data-route-close]').forEach(button => button.onclick = close);
    dialog.addEventListener('close', () => { if (!dialog.open) { cleanup(); current = null; } });
    win.document.body.append(dialog);
  }
  function drawOrigin(origin, label) {
    if (originMarker) originMarker.setLatLng([origin.lat,origin.lng]);
    else originMarker = win.L.circleMarker([origin.lat,origin.lng], {radius:8,color:'#fff',weight:3,fillColor:'#2563eb',fillOpacity:1}).addTo(map);
    originMarker.bindTooltip(label);
  }
  async function loadRoute(origin, destination, fromDevice, ticket) {
    if (ticket !== generation || !dialog.open || !map) return;
    lastRouteAt = Date.now();
    drawOrigin(origin, fromDevice ? 'Your location' : 'Company office');
    element('origin').textContent = fromDevice ? 'From your device location. Travel time is an estimate.' : 'From the company office. Allow location access to route from your current position.';
    element('directions').href = directionsFor(current, origin);
    controller?.abort();
    const request = new AbortController(); controller = request;
    const timeout = win.setTimeout(() => request.abort(), 12000);
    try {
      const query = new URLSearchParams({origin:`${origin.lat},${origin.lng}`,destination:`${destination.lat},${destination.lng}`});
      const response = await win.fetch('/api/services/directions?' + query, {credentials:'same-origin',signal:request.signal});
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.geometry) || data.geometry.length < 2 || !data.geometry.every(coords => Array.isArray(coords) && point({lng:coords[0],lat:coords[1]}))) throw Error('Route unavailable');
      if (ticket !== generation || controller !== request || !dialog.open) return;
      route = win.OrderRouteMap.draw({map,leaflet:win.L,previousLayer:route,quote:{source:'road',origin,destination,geometry:{type:'LineString',coordinates:data.geometry}}});
      const distance = Number(data.distance), duration = Number(data.duration_in_traffic ?? data.duration);
      element('distance').textContent = Number.isFinite(distance) && distance >= 0 ? `${(distance / 1000).toFixed(1)} km by road` : 'Road route';
      element('duration').textContent = Number.isFinite(duration) && duration >= 0 ? `About ${Math.max(1,Math.ceil(duration / 60))} min` : '';
      element('status').textContent = 'Follow the highlighted road route to the delivery address.';
    } catch (error) {
      if (ticket !== generation || controller !== request || !dialog.open) return;
      // A dashed connector is explicitly an estimate, never a claimed road route.
      route = win.OrderRouteMap.draw({map,leaflet:win.L,previousLayer:route,quote:{source:'estimated',origin,destination}});
      element('distance').textContent = 'Road route unavailable'; element('duration').textContent = '';
      element('status').textContent = 'The dashed line only connects the locations. Open directions for navigation.';
    } finally { win.clearTimeout(timeout); }
  }
  function open(order, options = {}) {
    if (!order?._id) return;
    mount();
    if (dialog.open && String(current?._id) === String(order._id)) return;
    cleanup(); current = order; lastRouteAt = 0;
    const ticket = generation, destination = destinationFor(order), company = point(options.company);
    element('reference').textContent = order.orderReference || order.orderNumber || 'Assigned order';
    element('customer').textContent = order.customer?.name || 'Customer';
    element('address').textContent = order.delivery?.address || 'No delivery address recorded';
    element('distance').textContent = 'Loading route...'; element('duration').textContent = ''; element('origin').textContent = '';
    const href = directionsFor(order); element('directions').hidden = !href;
    if (href) element('directions').href = href;
    element('map').hidden = !destination;
    if (!dialog.open) dialog.showModal();
    if (!destination || !win.L || !win.OrderRouteMap || !win.createEsriHybridLayer) {
      element('map').hidden = true;
      element('distance').textContent = destination ? 'Map unavailable' : 'Delivery map pin unavailable';
      element('status').textContent = 'Use Open directions with the saved delivery address.';
      return;
    }
    map = win.L.map(element('map'), {zoomControl:true}).setView([destination.lat,destination.lng], 14);
    win.createEsriHybridLayer().addTo(map);
    win.L.circleMarker([destination.lat,destination.lng], {radius:9,color:'#fff',weight:3,fillColor:'#e08c25',fillOpacity:1}).addTo(map).bindTooltip('Customer delivery location');
    win.requestAnimationFrame(() => { if (ticket === generation && dialog.open) map?.invalidateSize(); });
    element('status').textContent = 'Customer delivery location. Checking your current location...';
    if (company) loadRoute(company, destination, false, ticket);
    else element('distance').textContent = 'Customer delivery location';
    if (win.navigator?.geolocation) {
      watcher = win.navigator.geolocation.watchPosition(position => {
        const location = point({lat:position.coords.latitude,lng:position.coords.longitude});
        if (ticket !== generation || !dialog.open || !location) return;
        drawOrigin(location, 'Your location');
        if (!lastRouteAt || Date.now() - lastRouteAt > 20000 || !element('origin').textContent.startsWith('From your device')) loadRoute(location, destination, true, ticket);
      }, () => {
        if (ticket !== generation || !dialog.open) return;
        element('origin').textContent = company ? 'Location access unavailable. Showing the route from the company office.' : 'Location access unavailable. The map shows the saved customer location; use Open directions to navigate.';
      }, {enableHighAccuracy:true,maximumAge:15000,timeout:10000});
    }
  }
  function sync(orders) {
    if (!current || !dialog?.open) return;
    const latest = orders.find(order => String(order._id) === String(current._id));
    if (!latest || ['completed','cancelled','technician_declined'].includes(latest.status) || current.status === 'out_for_delivery' && latest.status !== 'out_for_delivery') return close();
    current = latest;
  }
  return {open,close,sync,point,destinationFor,directionsFor};
});
