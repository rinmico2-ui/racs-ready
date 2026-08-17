const ActivityLog = require('../models/ActivityLog');

// Ordered prefix-matching rules → derive the log `category` from the action string
const CATEGORY_RULES = [
  { prefixes: ['appointment.', 'booking.', 'booking_'], category: 'booking' },
  { prefixes: ['order.', 'pos.', 'walkin.', 'sale.'], category: 'order' },
  { prefixes: ['payment.', 'remittance', 'invoice'], category: 'payment' },
  { prefixes: ['assignment.', 'assign_'], category: 'assignment' },
  { prefixes: ['expense.'], category: 'expense' },
  { prefixes: ['project.'], category: 'project' },
  { prefixes: ['tool.', 'stock.', 'inventory'], category: 'inventory' },
  { prefixes: ['settings.'], category: 'settings' },
  { prefixes: ['staff.', 'role.', 'auth.', 'login', 'logout'], category: 'auth' },
];

// Fallback entity type when no referenceModel / explicit entityType is supplied
const ENTITY_BY_CATEGORY = {
  booking: 'BookingService',
  order: 'Order',
  payment: 'Payment',
  assignment: 'Assignment',
  project: 'Project',
  expense: 'Expense',
};

function classify(action, details, moduleName) {
  const a = String(action || '').toLowerCase();
  let category = 'system';
  for (const rule of CATEGORY_RULES) {
    if (rule.prefixes.some((p) => a.startsWith(p))) {
      category = rule.category;
      break;
    }
  }
  if (a === 'user_register') category = 'auth';

  const entityType =
    (details && details.referenceModel) ||
    (details && details.entityType) ||
    ENTITY_BY_CATEGORY[category] ||
    '';

  let actionType = 'action';
  if (a === 'login' || a === 'logout' || a === 'user_register') actionType = 'auth';
  else if (a.includes('create') || a.includes('checkout')) actionType = 'created';
  else if (a.includes('void') || a.includes('delete') || a.includes('remove')) actionType = 'deleted';
  else if (a.includes('cancel')) actionType = 'cancelled';
  else if (
    a.includes('status') || a.includes('verify') || a.includes('approve') ||
    a.includes('reject') || a.includes('accept') || a.includes('decline') ||
    a.includes('assign') || a.includes('complete') || a.includes('remit') ||
    a.includes('collect') || a.includes('paid') || a.includes('reset') ||
    a.includes('change')
  ) actionType = 'status_change';
  else if (a.includes('update') || a.includes('upsert') || a.includes('edit')) actionType = 'updated';

  return { category, entityType, actionType };
}

/**
 * Write an enterprise audit-log entry.
 *
 * All classification fields are auto-derived from the action string when not
 * explicitly provided, so existing callers keep working unchanged.
 */
async function logEvent({
  actor,
  target,
  action,
  module: moduleName,
  req,
  details,
  entityId,
  entityType,
  category,
  actionType,
  actorRole,
  actorName,
}) {
  try {
    const ip =
      (req &&
        (req.ip ||
          (req.headers &&
            (req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress))))) ||
      '';
    const d = Object.assign({}, details, { module: moduleName });
    const cls = classify(action, d, moduleName);

    await ActivityLog.create({
      actor,
      target,
      action,
      ip,
      details: d,
      module: moduleName || (d && d.module) || '',
      category: category || cls.category,
      entityType: entityType || cls.entityType,
      entityId: entityId || (d && d.referenceId) || null,
      actionType: actionType || cls.actionType,
      actorRole: actorRole || (d && d.actorRole) || '',
      actorName: actorName || (d && d.actorName) || '',
    });
  } catch (e) {
    console.warn('audit.logEvent error', e && e.message);
  }
}

module.exports = { logEvent, classify };