'use strict';
// Archived records and explicitly excluded test records never enter business reports.
const reportableMatch = () => ({ archivedAt: null, testDataExcludedAt: null });
const isReportable = row => Boolean(row && !row.archivedAt && !row.testDataExcludedAt);
module.exports = { reportableMatch, isReportable };
