const entries = new Map();

function cacheKey(namespace, input = {}) {
  const normalized = Object.keys(input || {})
    .sort()
    .reduce((result, key) => {
      const value = input[key];
      if (value !== undefined && value !== null && value !== "") result[key] = String(value);
      return result;
    }, {});
  return `${namespace}:${JSON.stringify(normalized)}`;
}

function prune(maxEntries) {
  if (entries.size <= maxEntries) return;
  const oldest = [...entries.entries()]
    .filter(([, entry]) => !entry.pending)
    .sort((left, right) => left[1].createdAt - right[1].createdAt);
  while (entries.size > maxEntries && oldest.length) entries.delete(oldest.shift()[0]);
}

/**
 * Small process-local cache for read-only reporting payloads. Pending promises
 * are shared as well, so two users opening the same report together do not run
 * the same expensive analytics twice. It deliberately has a short TTL: this
 * improves navigation without turning operational reports into stale exports.
 */
async function remember(namespace, input, producer, options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs) || 30000);
  const maxEntries = Math.max(5, Number(options.maxEntries) || 60);
  const key = cacheKey(namespace, input);
  const now = Date.now();
  const current = entries.get(key);
  if (current && (current.pending || current.expiresAt > now)) return current.value;

  const pending = Promise.resolve().then(producer);
  entries.set(key, { value: pending, pending: true, createdAt: now, expiresAt: now + ttlMs });
  try {
    const value = await pending;
    entries.set(key, { value, pending: false, createdAt: now, expiresAt: Date.now() + ttlMs });
    prune(maxEntries);
    return value;
  } catch (error) {
    entries.delete(key);
    throw error;
  }
}

function clear(namespace) {
  const prefix = `${namespace}:`;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

module.exports = { cacheKey, clear, remember };
