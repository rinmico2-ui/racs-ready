'use strict';
const privacy = require('./logPrivacy');
function problem(value) {
  const raw = String(value || '');
  if (/EAUTH|authentication|credentials|invalid.*key|api.?key|unauthori[sz]ed|535\b|401\b|403\b/i.test(raw)) return 'The email service could not sign in. Ask the server administrator to check its account access.';
  if (/ETIMEDOUT|ECONN|ENOTFOUND|ESOCKET|timeout|timed out|network|connect|ENETUNREACH|EAI_AGAIN/i.test(raw)) return 'The email service could not be reached. Check the server connection and try again.';
  if (/429|rate.?limit|quota|too many/i.test(raw)) return 'The email service is busy or has reached its sending limit. Wait before trying again.';
  if (/recipient|mailbox|address|bounce|550\b|553\b/i.test(raw)) return 'The message could not be delivered to this address. Check the recipient address and try again.';
  if (/missing|configured|configuration|sender|domain|verif/i.test(raw)) return 'Email setup needs attention. Ask the server administrator to check the sender and service settings.';
  return 'The email could not be sent. Ask the server administrator to check the email service, then try again.';
}
function configuration(status) {
  const issues = (status.issues || []).map(issue => /FROM_EMAIL/.test(issue) ? 'The sending email address is missing.'
    : /SMTP_HOST/.test(issue) ? 'The mail server address is missing.'
      : /SMTP_USER/.test(issue) ? 'The mail account is missing.' : 'Email service access has not been set up.');
  return { ...status, issues: [...new Set(issues)] };
}
function record(value) {
  return { id: value._id, provider: value.provider, recipient: privacy.maskEmail(value.recipient),
    subject: privacy.text(value.subject, 300).replace(/\[REDACTED\]/g, '(hidden)'), status: value.status, createdAt: value.createdAt,
    summary: value.status === 'accepted' ? 'Accepted by the email service. Delivery confirmation may still be pending.' : problem(value.error),
    canCheckDelivery: value.provider === 'brevo' && value.status === 'accepted' && Boolean(value.messageId) };
}
function delivery(value) {
  const labels = { request: 'Submitted to the email service', requests: 'Submitted to the email service', delivered: 'Accepted by the recipient’s mail server',
    deferred: 'Delivery delayed', softbounce: 'Temporary delivery issue', hardbounce: 'Address could not receive the message',
    blocked: 'Message blocked', invalidemail: 'Recipient address needs checking', invalid: 'Recipient address needs checking', error: 'Delivery issue',
    opened: 'Delivery confirmed', uniqueopened: 'Delivery confirmed', clicks: 'Delivery confirmed', clicked: 'Delivery confirmed', spam: 'Reported as unwanted email' };
  const message = value.status === 'delivered' ? 'The recipient mail server accepted this email. Check the inbox and spam folder; inbox placement is not guaranteed.'
    : value.status === 'rejected' ? 'A delivery problem was reported. Check the recipient address or ask the server administrator to review the email service.'
      : 'The email service accepted the message. A delivery confirmation is not available yet.';
  return { status: value.status, message, events: (value.events || []).map(row => ({
    event: labels[String(row.event || '').toLowerCase().replace(/[_-]/g, '')] || 'Delivery status updated', date: row.date,
  })) };
}
module.exports = { problem, configuration, record, delivery };
