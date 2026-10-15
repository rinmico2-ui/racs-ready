'use strict';
const { PDFDocument } = require('pdfkit');
const titles = { revenue: 'Sales and Payments', service: 'Service Report', orders: 'Order Report', inventory: 'Stock Report' };
const labels = value => String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const excluded = key => /(?:^_|Id$|Ids$|photo|image|url|email|phone|evidence)/i.test(key);
function display(value, key) {
  if (value == null) return '-';
  if (value instanceof Date) return value.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' });
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    const amount = /revenue|cost|value|balance|profit|amount|refund|collection|basicPay|netPay|grossPay/i.test(key) && !/percent|rate|count|coverage|growth/i.test(key);
    return (amount ? 'PHP ' : '') + value.toLocaleString('en-PH', { maximumFractionDigits: 2 });
  }
  return String(value).replace(/\u20b1/g, 'PHP ').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

async function buildReportPdf(kind, analytics, filters = {}) {
  if (!titles[kind] || !analytics || typeof analytics !== 'object') throw Object.assign(new Error('The report must load successfully before it can be exported.'), { status: 503 });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 38, bufferPages: true, info: { Title: titles[kind], Author: 'CALIDRO RACS' } });
  const chunks = [];
  const result = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const width = doc.page.width - 76;
  function space(height = 30) { if (doc.y + height > doc.page.height - 52) doc.addPage(); }
  function heading(text) { space(38); doc.moveDown(0.7).font('Helvetica-Bold').fontSize(12).fillColor('#1d4ed8').text(text).moveDown(0.5); }
  function table(rows) {
    if (!rows.length) return;
    const keys = [...new Set(rows.flatMap(row => Object.keys(row || {}).filter(key => !excluded(key) && row[key] !== null && typeof row[key] !== 'object')))].slice(0, 8);
    if (!keys.length) return;
    const columnWidth = width / keys.length;
    function row(values, header) {
      doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(header ? 8 : 8.5);
      const height = Math.max(24, ...values.map(text => doc.heightOfString(text, { width: columnWidth - 12 }))) + 10;
      space(height);
      const y = doc.y;
      if (header) doc.rect(38, y, width, height).fill('#edf2f7');
      values.forEach((text, index) => doc.fillColor('#172033').text(text, 44 + index * columnWidth, y + 5, { width: columnWidth - 12, height: height - 8 }));
      doc.moveTo(38, y + height).lineTo(38 + width, y + height).strokeColor('#e2e8f0').stroke();
      doc.x = 38; doc.y = y + height;
    }
    row(keys.map(labels), true);
    for (const entry of rows.slice(0, 2000)) {
      if (doc.y + 55 > doc.page.height - 52) { doc.addPage(); row(keys.map(labels), true); }
      row(keys.map(key => display(entry[key], key)), false);
    }
    if (rows.length > 2000) doc.moveDown().text(`Showing 2,000 of ${rows.length} rows. Narrow the report filters to export the remaining records.`, { width });
  }
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#172033').text(titles[kind]);
  doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('CALIDRO RACS | Generated ' + new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) + ' (Philippine time)');
  const scope = Object.entries(filters).filter(([key, value]) => !['format', 'download'].includes(key) && !excluded(key) && value !== '' && value != null && typeof value !== 'object').map(([key, value]) => labels(key) + ': ' + display(value, key));
  doc.moveDown().text(scope.join(' | ') || 'Current report scope', { width });
  if (analytics.reportStart || analytics.reportEnd) doc.text('Period: ' + display(analytics.reportStart, 'date') + ' to ' + display(analytics.reportEnd, 'date'));
  heading('Summary');
  table(Object.entries(analytics).filter(([key, value]) => typeof value === 'number' && !excluded(key)).map(([key, value]) => ({ metric: labels(key), value: display(value, key) })));
  for (const [key, value] of Object.entries(analytics)) {
    if (excluded(key)) continue;
    if (Array.isArray(value) && value.length && typeof value[0] === 'object') { heading(labels(key)); table(value); }
    else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const rows = Object.entries(value).filter(([field, scalar]) => !excluded(field) && ['number', 'string', 'boolean'].includes(typeof scalar)).map(([field, scalar]) => ({ metric: labels(field), value: display(scalar, field) }));
      if (rows.length) { heading(labels(key)); table(rows); }
    }
  }
  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page++) {
    doc.switchToPage(page);
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(`CALIDRO RACS | ${titles[kind]} | Page ${page + 1} of ${range.count}`, 38, doc.page.height - 30, { lineBreak: false, width });
  }
  doc.end();
  return result;
}
async function sendReportPdf(res, kind, analytics, filters) {
  const buffer = await buildReportPdf(kind, analytics, filters);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${kind}-report.pdf"`);
  return res.send(buffer);
}
module.exports = { buildReportPdf, sendReportPdf };
