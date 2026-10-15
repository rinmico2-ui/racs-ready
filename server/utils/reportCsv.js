'use strict';
const titles = { overview: 'Report Center', revenue: 'Sales and Payments', service: 'Service Reports', orders: 'Order Reports', inventory: 'Stock Reports', customers: 'Customer Activity', service_ratings: 'Customer Ratings', technician_ratings: 'Technician Ratings' };
const label = text => String(text).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const excluded = key => /(?:^_|^(?:id|ids)$|_(?:id|ids)$|photo|image|url|email|phone|password|token|secret|evidence|receipt)/i.test(key) || /Ids?$/.test(key);
function cell(value) {
  let result = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  // Excel and LibreOffice must treat untrusted labels/comments as text.
  if (typeof value !== 'number' && /^[\s\u0000-\u001f]*[=+\-@]/.test(result)) result = "'" + result;
  return '"' + result.replace(/"/g, '""') + '"';
}
function csvRows(headers, rows) {
  if (rows.length > 50000) throw Object.assign(Error('This export exceeds 50,000 rows. Select a smaller date range.'), { status: 413 });
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
function buildReportCsv(kind, analytics, filters = {}) {
  if (!titles[kind] || !analytics || typeof analytics !== 'object' || analytics.partial || analytics.reportError) throw Object.assign(Error('Load the complete report before downloading CSV.'), { status: 503 });
  const rows = [], add = (section, record, metric, value) => rows.push([titles[kind], section, record, label(metric), typeof value === 'boolean' ? value ? 'Yes' : 'No' : value]);
  add('Report information', '', 'generatedAt', new Date());
  add('Report information', '', 'timeZone', 'Asia/Manila');
  add('Report information', '', 'scope', 'Report totals, chart series and report detail summaries; amounts are PHP.');
  for (const [key, value] of Object.entries(filters)) if (!excluded(key) && !['format','download'].includes(key) && ['string','number'].includes(typeof value)) add('Filters', '', key, value);
  function walk(object, section, record = '', depth = 0) {
    if (depth > 4 || !object || typeof object !== 'object') return;
    for (const [key, value] of Object.entries(object)) {
      if (excluded(key) || value == null || ['filterOptions','allRows','sourceHealth','pagination','filters','appliedFilters'].includes(key)) continue;
      if (Array.isArray(value)) {
        value.forEach((row, index) => {
          const name = row && typeof row === 'object' ? row.reference || row.bookingReference || row.orderReference || row.name || row.serviceName || row.itemName || row.date || index + 1 : index + 1;
          if (row && typeof row === 'object') walk(row, section === 'Summary' ? label(key) : section + ' / ' + label(key), String(name), depth + 1);
          else add(section, record, `${label(key)} ${index + 1}`, row);
        });
      } else if (value instanceof Date || ['number','string','boolean'].includes(typeof value)) add(section, record, key, value);
      else walk(value, section === 'Summary' ? label(key) : section + ' / ' + label(key), record, depth + 1);
    }
  }
  walk(analytics, 'Summary');
  return csvRows(['Report','Section','Record','Metric','Value'], rows);
}
function sendCsv(res, filename, headers, rows) {
  const body = csvRows(headers, rows);
  res.set('Cache-Control', 'private, no-store'); res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename.replace(/[^a-z0-9_.-]/gi,'-')}.csv"`);
  return res.send(body);
}
function sendReportCsv(res, kind, analytics, filters = {}) {
  const body = buildReportCsv(kind, analytics, filters);
  res.set('Cache-Control', 'private, no-store'); res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${kind}-report.csv"`); return res.send(body);
}
module.exports = { cell, csvRows, buildReportCsv, sendReportCsv, sendCsv };
