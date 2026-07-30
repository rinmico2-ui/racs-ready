// Placeholder for PSGC data file.
// Previously used for embedded PSGC samples. The frontend now fetches live data
// from https://psgc.cloud/api/v2/* and does not require a local data file.
// This file exists to avoid 404 / MIME errors when referenced by templates.

// Export a minimal object in case any legacy code expects it.
window.psgcData = window.psgcData || { provinces: [], cities: {}, barangays: {}, postalCodes: {} };
