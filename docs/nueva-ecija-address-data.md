The customer service area is Nueva Ecija. Coordinates are checked against the province polygon on the server and in customer map controls; a bounding rectangle alone does not establish coverage.

The boundary in `server/public/js/nueva-ecija-coverage.js` is OpenStreetMap relation [52306](https://www.openstreetmap.org/relation/52306), retrieved through Nominatim on 2026-10-15. © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).

The local address catalog contains the Nueva Ecija province record, 32 cities/municipalities, and 849 barangays retrieved on 2026-10-15 from [PSGC.cloud](https://psgc.cloud/): `/api/v2/provinces`, `/api/v2/cities-municipalities`, and `/api/v2/provinces/0304900000/barangays`.

Local suggestions identify administrative localities, not an exact house or geocoded pin. They carry `match_level: locality` and no coordinates. Selecting one preserves its address label and requires the customer to place and confirm the actual map pin. External geocoders supply street and point matches when available. Do not substitute an invented house or barangay coordinate when providers are unavailable.

When provincial boundaries or PSGC records change, verify both sources before updating the bundled snapshots and rerun the coverage, registration/profile, and checkout tests.

The snapshot retains locality names and codes, and omits provider ZIP-code fields that could not be verified. Customers can enter their four-digit postal code. Existing saved postal codes are preserved.
