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

    // Esri coverage varies by location. At native level 19 and above the
    // service can return a successful JPEG whose contents say "Map data not
    // available", so Leaflet's tile-error event cannot provide a fallback.
    // Stop native requests at level 18 and let Leaflet enlarge those tiles for
    // close pin and route inspection. Users can still zoom to level 22 without
    // requesting the unreliable native levels 19-22.
    const settings = Object.assign({ maxNativeZoom: 18, maxZoom: 22 }, options || {});
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
