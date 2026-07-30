const axios = require("axios");

// Helper for Nager.Date public holidays API
// Example endpoint: https://date.nager.at/api/v3/PublicHolidays/2026/AT
// Exports getPublicHolidays(countryCode, year)
//  - countryCode: ISO 3166-1 alpha-2 code (PH, US, AT, etc.)
//  - year: integer year
// Returns an array of holiday objects from the API
// See docs: https://date.nager.at/swagger/index.html

async function getPublicHolidays(countryCode, year) {
  if (!countryCode) throw new Error("countryCode is required");
  if (!year || typeof year !== "number")
    throw new Error("year must be a number");

  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data || [];
}

module.exports = { getPublicHolidays };
