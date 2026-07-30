const ActivityLog = require('../models/ActivityLog');

async function logEvent({ actor, target, action, module: moduleName, req, details }) {
  try {
    const ip = req && (req.ip || req.headers && (req.headers['x-forwarded-for'] || req.connection && req.connection.remoteAddress)) || '';
    await ActivityLog.create({ actor, target, action, ip, details: Object.assign({}, details, { module: moduleName }) });
  } catch (e) {
    console.warn('audit.logEvent error', e && e.message);
  }
}

module.exports = { logEvent };
