const SiteSetting = require("../models/SiteSetting");
const { DEFAULT_STORE_HOURS } = require("./orderCheckoutPolicy");

async function getOrderCheckoutSettings() {
  const keys = [
    "farePerKm",
    "airconInstallFee",
    "companyLocationLat",
    "companyLocationLng",
    "storeOpenHours",
  ];
  const rows = await SiteSetting.find({ key: { $in: keys } }).lean();
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const fare = Number(settings.farePerKm);
  const installation = Number(settings.airconInstallFee);
  const lat = Number(settings.companyLocationLat);
  const lng = Number(settings.companyLocationLng);
  return {
    farePerKm: Number.isFinite(fare) && fare >= 0 ? fare : 40,
    installationFee: Number.isFinite(installation) && installation >= 0 ? installation : 1500,
    companyLocation: {
      lat: Number.isFinite(lat) ? lat : 14.676049,
      lng: Number.isFinite(lng) ? lng : 121.043731,
    },
    storeHours: Array.isArray(settings.storeOpenHours) ? settings.storeOpenHours : DEFAULT_STORE_HOURS,
  };
}

module.exports = { getOrderCheckoutSettings };
