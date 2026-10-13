'use strict';
async function reported(reports, req) {
  const { createNotification } = require('./notify');
  for (const report of Array.isArray(reports) ? reports : [reports]) {
    await createNotification({ type: 'kit_return_reported', role: 'admin', title: 'Kit return needs review', message: `${report.name}: a technician submitted a return or unused-material report. Stock stays unavailable until you receive and confirm it.`, referenceId: report._id, referenceModel: 'KitReturn', link: '/admin/inventory/equipment-returns', priority: 'high', io: req.app.get('io') || global.io });
  }
}
async function reviewed(report, req) {
  const { createNotification } = require('./notify');
  await createNotification({ type: 'kit_return_reviewed', userId: report.technicianId, role: 'technician', title: report.status === 'received' ? 'Return received by admin' : 'Return report needs correction', message: `${report.name}: ${report.status === 'received' ? 'admin confirmed your return.' : report.receiptNotes}`, referenceId: report._id, referenceModel: 'KitReturn', link: '/technician/tools', io: req.app.get('io') || global.io });
}
module.exports = { reported, reviewed };
