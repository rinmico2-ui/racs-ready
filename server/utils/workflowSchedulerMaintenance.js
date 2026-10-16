"use strict";

// Scheduled workflow writes must observe the current database setting, including
// when another application instance enabled maintenance. Authentication and its
// email worker remain available so administrators can sign in and recover access.
async function isWorkflowMaintenanceEnabled() {
  const configuration = await require("./systemConfiguration").getSystemConfiguration({ bypassCache: true });
  return configuration.maintenance.enabled === true;
}

async function runWorkflowScheduledTask(task) {
  if (await isWorkflowMaintenanceEnabled()) return { pausedForMaintenance: true };
  // A failed settings read rejects before any workflow task can write.
  return task();
}

module.exports = { isWorkflowMaintenanceEnabled, runWorkflowScheduledTask };
