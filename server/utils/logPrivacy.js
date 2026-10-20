'use strict';
const { isIP } = require('node:net');
const REDACTED = '[REDACTED]';
const PRIVATE = '[PRIVATE]';
const SECRET_KEY = /password|passwd|passcode|(?:^|_)pass$|token|secret|authorization|cookie|csrf|otp|credential|session|apikey|api_key|privatekey|private_key|connectionstring|connection_string|cvv|cvc|cardnumber|card_number|accountnumber|account_number|iban|emailbody|email_body|htmlbody|html_body|^html$|^body$|^payload$/i;
const PRIVATE_KEY = /^(?:address|street|location|coordinates|latitude|longitude|birthdate|dateofbirth|governmentid|taxid|nationalid)$/i;
function maskEmail(value) {
  return String(value || '').replace(/([\w.!#$%&'*+/=?^`{|}~-]+)@([\w.-]+\.[a-z]{2,})/gi,
    (_match, name, domain) => `${name.slice(0, 1)}***@${domain}`);
}
function maskIp(value) {
  const text = String(value || '').replace(/^::ffff:/, '');
  if (isIP(text) === 4) return text.split('.').slice(0, 3).join('.') + '.xxx';
  if (isIP(text) === 6) return text.split(':').slice(0, 3).join(':') + ':…';
  return text ? PRIVATE : '';
}
function sanitizePath(value) {
  return String(value || '').split(/[?#]/)[0]
    .replace(/((?:reset-password|password-reset|verify-email|verify-invitation|activate-invitation|setup-account|no-show)\/)[^/]+/gi, '$1[REDACTED]')
    .replace(/\b[a-f\d]{32,}\b/gi, REDACTED).slice(0, 500);
}
function text(value, max = 2000) {
  let result = String(value ?? '');
  result = result.replace(/(["'](?:password|passcode|api[-_]?key|secret|token|authorization|cookie)["']\s*:\s*)(["'])(.*?)\2/gi, '$1"[REDACTED]"')
    .replace(/\b((?:mongodb(?:\+srv)?|https?|smtps?):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:Bearer|Basic)\s+[\w.+/=-]+/gi, 'Authorization [REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, REDACTED)
    .replace(/\b(?:sk_(?:live|test)_[\w-]+|xkeysib-[\w-]+|GOCSPX-[\w-]+|AIza[\w-]{15,}|gsk_[\w-]{15,})\b/g, REDACTED)
    .replace(/((?:password|passcode|api[-_ ]?key|secret|token|authorization|cookie|SMTP_PASS|MONGODB_URI)\s*[=:]\s*)["']?[^\s,"';}]+["']?/gi, '$1[REDACTED]')
    .replace(/([?&](?:code|key|token|secret|signature|password|otp|access_token|refresh_token|api_key)=)[^\s&#"']+/gi, '$1[REDACTED]')
    .replace(/(\b(?:OTP|verification code|one[- ]time (?:code|password)|security code|login code)\b\s*(?::|is|=|-)?\s*)\d{4,8}\b/gi, '$1[REDACTED]')
    .replace(/\b\d{4,8}(?=\s+(?:is your|verification|login|OTP)\b)/gi, REDACTED)
    .replace(/\b(?:otp|verification|login|security|sign[- ]in|authentication|one[- ]time)\b.{0,45}?\b\d{4,8}\b/gi,
      value => value.replace(/\b\d{4,8}\b/g, REDACTED))
    .replace(/(?:\+?63[\s-]?9\d{2}|09\d{2})[\s-]?\d{3}[\s-]?\d{4}\b/g, value => '***' + value.replace(/\D/g, '').slice(-4))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, value => isIP(value) === 4 ? maskIp(value) : value);
  return maskEmail(result).slice(0, max);
}
function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^\s*[{[]/.test(value)) {
      try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return sanitize(parsed, depth + 1, seen); } catch (_) {}
    }
    return text(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toHexString === 'function') return value.toHexString();
  if (typeof value !== 'object') return text(value);
  if (Buffer.isBuffer(value)) return REDACTED;
  if (depth >= 6) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1, seen));
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const normalized = key.replace(/[^\w]/g, '').toLowerCase();
    if ((SECRET_KEY.test(key) || SECRET_KEY.test(normalized)) && typeof item !== 'boolean') output[key] = REDACTED;
    else if (PRIVATE_KEY.test(normalized) || /(?:address|coordinates)$/.test(normalized)) output[key] = PRIVATE;
    else if (/^(?:ip|ipaddress|remoteaddress)$/i.test(normalized)) output[key] = maskIp(item);
    else if (/(?:phone|mobile|contactnumber|phonenumber|mobilenumber)$/i.test(normalized) && item) output[key] = '***' + String(item).replace(/\D/g, '').slice(-4);
    else if (/^(?:code|verificationcode|securitycode)$/i.test(normalized) && /^\d{4,8}$/.test(String(item))) output[key] = REDACTED;
    else if (/^(?:requestpath|url|link|path)$/i.test(normalized) && typeof item === 'string') output[key] = text(sanitizePath(item));
    else output[key] = sanitize(item, depth + 1, seen);
  }
  return output;
}
function device(value) {
  const ua = String(value || '');
  if (!ua) return '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const platform = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Macintosh/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
  return platform ? `${browser} on ${platform}` : browser;
}
function auditRecord(record) {
  return { ...record, actorName: text(record.actorName || '', 200), targetName: text(record.targetName || '', 200),
    actorEmail: maskEmail(record.actorEmail), targetEmail: maskEmail(record.targetEmail),
    action: text(record.action, 200), ip: maskIp(record.ip), requestPath: text(sanitizePath(record.requestPath), 500),
    requestId: text(record.requestId || '', 100), module: text(record.module || '', 80), actorRole: text(record.actorRole || '', 80),
    userAgent: device(record.userAgent), details: sanitize(record.details || {}) };
}
module.exports = { text, sanitize, maskEmail, maskIp, sanitizePath, auditRecord, device };
