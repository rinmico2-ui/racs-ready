const ActivityLog = require('../models/ActivityLog');
const crypto = require('crypto');

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
  { prefixes: ['staff.', 'role.', 'auth.', 'password_', 'login', 'logout'], category: 'auth' },
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
  if (category === 'auth') actionType = 'security';
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

const SENSITIVE_DETAIL_KEY = /(password|passcode|token|secret|authorization|cookie|csrf|otp|credential|session)/i;

function sanitizeDetails(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value).slice(0, 2000);
  if (depth >= 6) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeDetails(item, depth + 1, seen));
  }

  const output = {};
  Object.entries(value).slice(0, 100).forEach(([key, item]) => {
    output[key] = SENSITIVE_DETAIL_KEY.test(key)
      ? '[REDACTED]'
      : sanitizeDetails(item, depth + 1, seen);
  });
  return output;
}

function normalizeIp(req) {
  if (!req) return '';
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  const raw = req.ip || (forwarded && String(forwarded).split(',')[0]) ||
    (req.connection && req.connection.remoteAddress) || '';
  return String(raw).replace(/^::ffff:/, '').slice(0, 100);
}

function inferOutcome(action) {
  const value = String(action || '').toLowerCase();
  if (/(blocked|rate_limit|locked)/.test(value)) return 'blocked';
  if (/(failed|failure|invalid|denied|rejected|error)/.test(value)) return 'failure';
  if (/(requested|pending|submitted|email_sent)/.test(value)) return 'pending';
  return 'success';
}

function inferRiskLevel(action, category, outcome) {
  const value = String(action || '').toLowerCase();
  if (outcome === 'blocked' || /(suspicious|unauthorized|account_takeover)/.test(value)) return 'critical';
  if (/(password_reset_completed|staff\.reset_password|refund|void|delete)/.test(value)) return 'high';
  if (category === 'auth' || outcome === 'failure') return 'medium';
  if (/(payment|inventory|payroll|settings)/.test(value)) return 'low';
  return 'info';
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
  outcome,
  riskLevel,
  source,
}) {
  try {
    const ip = normalizeIp(req);
    const d = sanitizeDetails(Object.assign({}, details, { module: moduleName }));
    const cls = classify(action, d, moduleName);
    const resolvedOutcome = outcome || inferOutcome(action);
    const resolvedRisk = riskLevel || inferRiskLevel(action, category || cls.category, resolvedOutcome);
    const resolvedSource = source || (req
      ? (actor || req.user ? 'authenticated_user' : 'unauthenticated_request')
      : 'system');
    let requestId = '';
    if (req) {
      requestId = String(req.auditRequestId || (req.headers && req.headers['x-request-id']) || '').slice(0, 100);
      if (!requestId) {
        requestId = crypto.randomUUID();
        req.auditRequestId = requestId;
      }
    }

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
      actorName: actorName || (d && d.actorName) ||
        (resolvedSource === 'unauthenticated_request' ? 'Unauthenticated requester' : ''),
      outcome: resolvedOutcome,
      riskLevel: resolvedRisk,
      source: resolvedSource,
      requestId,
      requestMethod: req ? String(req.method || '').slice(0, 12).toUpperCase() : '',
      requestPath: req ? String(req.originalUrl || req.url || '').split('?')[0].slice(0, 500) : '',
      userAgent: req && req.headers ? String(req.headers['user-agent'] || '').slice(0, 512) : '',
    });
  } catch (e) {
    console.warn('audit.logEvent error', e && e.message);
  }
}

module.exports = {
  logEvent,
  classify,
  sanitizeDetails,
  normalizeIp,
  inferOutcome,
  inferRiskLevel,
};
