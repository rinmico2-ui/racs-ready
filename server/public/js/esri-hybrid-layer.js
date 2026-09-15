(function initializeEsriHybridLayer(global) {
  "use strict";

  const IMAGERY_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const LABELS_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";

  /**
   * Build the single approved basemap used by the application. Keeping this
   * provider in one place prevents a page from accidentally returning to the
   * volunteer OpenStreetMap tile service.
   */
  global.createEsriHybridLayer = function createEsriHybridLayer(options) {
    const leaflet = global.L;
    if (!leaflet) throw new Error("Leaflet must load before the Esri hybrid layer");

    // Esri advertises deeper zoom levels globally, but coverage varies by
    // location. In areas without those tiles the service returns a JPEG that
    // says "Map data not available" with a successful HTTP response, so a
    // normal tile-error fallback cannot catch it. Treat level 19 as the last
    // native level and let Leaflet enlarge those valid tiles for close pin and
    // route inspection. Zoom 22 gives three additional levels without asking
    // Esri for the unavailable native tiles at levels 20-22.
    const settings = Object.assign({ maxNativeZoom: 19, maxZoom: 22 }, options || {});
    const imagery = leaflet.tileLayer(IMAGERY_URL, Object.assign({}, settings, {
      attribution: "Tiles &copy; Esri",
    }));
    const labels = leaflet.tileLayer(LABELS_URL, Object.assign({}, settings, {
      attribution: "Labels &copy; Esri",
    }));
    const group = leaflet.layerGroup([imagery, labels]);

    // Expose the child layers for diagnostics without coupling callers to them.
    group.imageryLayer = imagery;
    group.labelsLayer = labels;
    return group;
  };
})(window);
