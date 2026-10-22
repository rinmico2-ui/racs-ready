'use strict';

// A planning operation may cover several jobs using the same service rules
// and inventory. Reuse reads only within that operation, never across visits.
function preparationRead(options, label, query, read) {
  if (!(options?.readCache instanceof Map)) return read();
  const key = label + ':' + JSON.stringify(query, (_name, value) => value instanceof RegExp ? value.toString() : value);
  if (!options.readCache.has(key)) options.readCache.set(key, Promise.resolve().then(read));
  return options.readCache.get(key);
}

module.exports = { preparationRead };
