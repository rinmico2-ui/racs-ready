"use strict";

const { getSystemConfiguration, isMaintenanceExempt } = require("../utils/systemConfiguration");

module.exports = async function maintenanceMode(req, res, next) {
  try {
    const configuration = await getSystemConfiguration();
    if (!configuration.maintenance.enabled || isMaintenanceExempt(req.originalUrl, req.user && req.user.role)) {
      return next();
    }

    res.set("Cache-Control", "no-store");
    if (req.originalUrl.startsWith("/api/") || req.xhr || String(req.headers.accept || "").includes("application/json")) {
      return res.status(503).json({
        error: configuration.maintenance.message,
        maintenance: true,
      });
    }

    return res.status(503).render("pages/system-maintenance", {
      title: "Scheduled Maintenance",
      layout: false,
      message: configuration.maintenance.message,
    });
  } catch (error) {
    // A settings/database read failure must not accidentally take the site down.
    return next();
  }
};
