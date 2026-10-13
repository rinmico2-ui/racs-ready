'use strict';
const { imageMimeFromSignature } = require('./uploadSecurity');
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

// Modern MongoDB drivers retain metadata but no longer store the deprecated
// GridFS contentType option. Read older receipts without rewriting evidence.
async function resolveStoredReceiptType(file, openDownload, { allowPdf = true } = {}) {
  const allowed = type => TYPES.has(type) && (allowPdf || type !== 'application/pdf');
  for (const value of [file?.metadata?.contentType, file?.contentType]) {
    const type = String(value || '').trim().toLowerCase();
    if (allowed(type)) return type;
  }
  if (!file || !Number.isFinite(Number(file.length)) || Number(file.length) <= 0) return '';
  const stream = openDownload({ start: 0, end: Math.min(16, Number(file.length)) });
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const header = Buffer.from(chunk).subarray(0, 16 - bytes);
      chunks.push(header); bytes += header.length;
      if (bytes >= 16) break;
    }
  } finally { stream.destroy(); }
  const header = Buffer.concat(chunks);
  const type = imageMimeFromSignature(header) || (header.toString('ascii', 0, 5) === '%PDF-' ? 'application/pdf' : '');
  return allowed(type) ? type : '';
}
module.exports = { resolveStoredReceiptType };
