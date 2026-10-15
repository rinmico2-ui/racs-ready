# Address search recovery

## Incident

On October 14, 2026, `/api/geocoding/autocomplete?q=Puncan` returned 502. The application selected Photon because no Geoapify autocomplete key was configured. A direct Photon request with the same Philippine country and bounding-box filters timed out. An explicit Nominatim search returned **Puncan, Carranglan, Nueva Ecija, Central Luzon, Philippines**. The query was valid; the live provider was unavailable.

## Behavior

- Live provider failures return a structured 503 with a retry interval and an instruction to use Search or the map. Provider throttling returns 429. The status endpoint reports local provider availability without issuing another upstream request.
- A failed provider pauses for 30 seconds, or longer when its `Retry-After` requires it. The application skips the failed provider during this interval. The existing Geoapify-to-Photon fallback, successful-result caching, deduplication and concurrent-work limits remain in place.
- Malformed upstream payloads count as failures. They cannot be cached as empty successful results. Valid empty search results remain distinct from outages.
- The service form displays **Search this address** and **Keep this address and place a pin**. Editing an address during a cooldown preserves these actions without issuing more live requests. Manual search runs only when the customer chooses it. The purchase checkout's shared address component also offers explicit Search after a failure.
- Delayed responses cannot replace suggestions for a different query. Network and non-JSON errors display inline guidance. Provider diagnostics record only a safe failure classification, without addresses, API keys or raw Axios configuration.

This change keeps booking usable during a provider outage; it cannot restore the external Photon service. Live suggestions are retried after the cooldown when the customer types again. Existing `GEOAPIFY_API_KEY` and `PHOTON_BASE_URL` settings can select the configured live provider; no secrets or actual `.env` values were changed.

## Provider constraints

The existing explicit search remains cached, deduplicated and serialized at least 1.1 seconds apart. Public Nominatim **prohibits autocomplete**, requires an identifying User-Agent and attribution, and limits an application to one request per second. Do not call it automatically as an autocomplete fallback. See the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).

Photon's public demo [does not guarantee availability](https://github.com/komoot/photon#demo-server). Its supported [country and bounding-box filters](https://github.com/komoot/photon/blob/master/docs/api-v1.md) match the request used here.

## Verification

- 13 new regression tests passed; the final focused run passed all 30 address and service checks.
- Full suite: **2,011 passed, 0 failed**.
- An isolated browser rendered the actual service form at 1440, 390 and 320 px. Checks passed for visible recovery actions, explicit Puncan Search, cooldown suppression, preserved manual-address pins, failed manual searches, and a provider already marked unavailable. The shared purchase address component also completed recovery and selection. Mock APIs were used; no live bookings or database records were changed.
- JavaScript syntax, EJS compilation and whitespace checks passed.
