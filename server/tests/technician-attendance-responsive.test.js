const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const attendancePath = path.join(__dirname, '..', 'views', 'pages', 'technician', 'Attendance.ejs');
const attendanceView = fs.readFileSync(attendancePath, 'utf8');

test('technician attendance provides touch-friendly mobile check-in and checkout actions', () => {
  assert.match(attendanceView, /@media \(max-width: 767px\)/);
  assert.match(attendanceView, /\.att-checkout-btn\s*\{[^}]*min-height:\s*52px/s);
  assert.match(attendanceView, /\.att-sm-btn\s*\{[^}]*min-height:\s*48px/s);
  assert.match(attendanceView, /\.att-detail-row\s*\{[^}]*grid-template-columns:/s);
});

test('technician attendance camera target adapts to the available reader width', () => {
  assert.match(attendanceView, /const readerWidth = reader\.clientWidth/);
  assert.match(attendanceView, /const qrSize = Math\.max\(160, Math\.min\(250, readerWidth - 32\)\)/);
  assert.match(attendanceView, /qrbox:\s*\{ width: qrSize, height: qrSize \}/);
});

test('technician attendance exposes its loaded state and a mobile-safe leave dialog', () => {
  assert.match(attendanceView, /page\.dataset\.attendanceState = attendanceState/);
  assert.match(attendanceView, /#leaveModal \.modal-content\s*\{[^}]*100dvh/s);
  assert.match(attendanceView, /safe-area-inset-bottom/);
});
