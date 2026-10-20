'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Assignment = require('../models/Assignment');
const Booking = require('../models/BookingService');
const Technician = require('../models/Technician');
const middleware = require('../utils/standardTeamMiddleware');
const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const view = read('views/pages/technician/assignments.ejs');
const id = number => number.toString(16).padStart(24, '0');
const assignmentId = id(1), technicianId = id(2), replacementId = id(3), bookingId = id(4);
const query = value => ({ lean: async () => value });

async function access(t, { method = 'GET', status = 'cancelled', actor = technicianId, released = true, archived = false } = {}) {
  const assignment = { _id: assignmentId, bookingId, technicianId, serviceType: 'core', status };
  const booking = { _id: bookingId, status: released ? 'pending_reassignment' : 'assigned',
    technicianId: released ? null : replacementId, archivedAt: archived ? new Date() : null,
    technicianTeam: [{ technicianId: replacementId, assignmentId: id(5), status: 'accepted' }] };
  t.mock.method(Assignment, 'findById', () => query(assignment));
  t.mock.method(Booking, 'findById', () => query(booking));
  t.mock.method(Technician, 'findOne', () => query({ _id: actor }));
  let passed = false;
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await middleware({ params: { id: assignmentId }, method, path: method === 'GET' ? '/' : '/status', body: { status: 'en_route' }, user: { _id: id(9) } },
    response, error => { if (error) throw error; passed = true; });
  return { passed, response };
}

for (const method of ['GET', 'HEAD']) for (const released of [true, false]) {
  test(`${method}: the owner can read a cancelled visit after its team is ${released ? 'released' : 'replaced'}`, async t => {
    assert.equal((await access(t, { method, released })).passed, true);
  });
}
test('a replacement technician cannot read the cancelled assignment belonging to someone else', async t => {
  const result = await access(t, { actor: replacementId, released: false });
  assert.equal(result.passed, false);
  assert.equal(result.response.code, 403);
  assert.equal(result.response.body.code, 'ASSIGNMENT_ACCESS_CHANGED');
});
test('historical read access does not allow status or payment writes', async t => {
  const result = await access(t, { method: 'POST' });
  assert.equal(result.passed, false);
  assert.equal(result.response.code, 403);
});
test('an active stale assignment still requires current team membership', async t => {
  const result = await access(t, { status: 'accepted', released: false });
  assert.equal(result.passed, false);
  assert.equal(result.response.code, 403);
});
test('archived bookings do not acquire historical access through this exception', async t => {
  assert.equal((await access(t, { archived: true })).passed, false);
});

function frontend({ ok = true, networkError = false } = {}) {
  const events = [], messages = [], nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) {
      const classes = new Set(['open', 'panel-open', 'list-hidden']);
      nodes.set(key, { style: { display: 'block' }, classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
        addEventListener(event, handler) { this[event] = handler; }, value: '', scrollTop: 0 });
    }
    return nodes.get(key);
  }
  node('cancelReasonSelect').value = 'emergency';
  node('customReasonText').value = '';
  const window = { _currentDetailId: assignmentId, _detailAssignment: { _id: assignmentId, status: 'en_route' },
    TechnicianWorkUpdates: { beginMutation() { events.push('begin'); return refresh => events.push(['finish', refresh]); } } };
  const context = vm.createContext({ window, document: { getElementById: node, querySelector: () => null }, AbortController,
    navigator: { geolocation: { clearWatch() {} } },
    detailLoadSequence: 1, detailLoad: null, detailLoadController: { abort() { events.push('abort'); } },
    cancelTargetId: assignmentId, currentFilter: 'all', currentPage: 1,
    bootstrap: { Modal: { getOrCreateInstance: () => ({ hide() { events.push('hide-cancel-dialog'); } }) } },
    async fetch() { events.push('cancel-request'); if (networkError) throw Error('Offline'); return { ok, json: async () => ok ? { message: 'Cancelled' } : { error: 'Cannot cancel this assignment.' } }; },
    async loadAssignments() { events.push('list-refresh'); }, showNotification: message => messages.push(message),
    console: { error: (...args) => events.push(['error', ...args]) } });
  const closeStart = view.indexOf('    window.closeDetailPanel = function () {');
  const closeEnd = view.indexOf('\n    };', closeStart) + '\n    };'.length;
  vm.runInContext(view.slice(closeStart, closeEnd), context);
  const start = view.indexOf("    document.getElementById('confirmCancelBtn').addEventListener('click', async function () {");
  const end = view.indexOf('\n    });', start) + '\n    });'.length;
  vm.runInContext(view.slice(start, end), context);
  return { context, window, events, messages, node, cancel: () => node('confirmCancelBtn').click.call(node('confirmCancelBtn')) };
}

test('successful cancellation clears and closes the job before the coordinated refresh', async () => {
  const f = frontend();
  await f.cancel();
  assert.equal(f.window._currentDetailId, null);
  assert.equal(f.window._detailAssignment, null);
  assert.equal(f.context.cancelTargetId, null);
  assert.equal(f.node('rightPanel').classList.contains('open'), false);
  assert.equal(f.context.detailLoadSequence, 2);
  assert.ok(f.events.indexOf('abort') < f.events.findIndex(event => Array.isArray(event) && event[0] === 'finish'));
  assert.deepEqual(f.events.at(-1), ['finish', true]);
  assert.equal(f.events.includes('list-refresh'), false, 'The update coordinator owns the one refresh');
  assert.equal(f.messages[0].title, 'Emergency Reported');
});
for (const networkError of [false, true]) test(`${networkError ? 'network failure' : 'rejected cancellation'} preserves the open assignment and releases the refresh lock`, async () => {
  const f = frontend({ ok: false, networkError });
  await f.cancel();
  assert.equal(f.window._currentDetailId, assignmentId);
  assert.equal(f.context.cancelTargetId, assignmentId);
  assert.equal(f.node('rightPanel').classList.contains('open'), true);
  assert.equal(f.events.includes('abort'), false);
  assert.deepEqual(f.events.at(-1), ['finish', false]);
  assert.equal(f.messages[0].title, 'Report Failed');
});

function detailLoader(f) {
  const start = view.indexOf('    async function loadAssignmentDetail(id, sequence) {');
  const end = view.indexOf('\n    };\n\n    function showNotification', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInContext('(' + view.slice(start, end) + '\n    })', f.context);
}
test('a stale access response closes the detail and refreshes the list without a Load Failed error', async () => {
  const f = frontend();
  f.context.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'This team assignment is no longer yours.', code: 'ASSIGNMENT_ACCESS_CHANGED' }) });
  await detailLoader(f)(assignmentId, 1);
  assert.equal(f.window._currentDetailId, null);
  assert.equal(f.node('rightPanel').classList.contains('open'), false);
  assert.equal(f.messages[0].title, 'Assignment updated');
  assert.equal(f.events.filter(event => event === 'list-refresh').length, 1);
  assert.equal(f.events.some(event => Array.isArray(event) && event[0] === 'error'), false);
});
test('closing while a detail response is in flight does not reopen the assignment or report a stale error', async () => {
  const f = frontend();
  let respond;
  f.context.fetch = () => new Promise(resolve => { respond = resolve; });
  const loading = detailLoader(f)(assignmentId, 1);
  f.window.closeDetailPanel();
  respond({ ok: false, status: 403, json: async () => ({ error: 'No longer yours.', code: 'ASSIGNMENT_ACCESS_CHANGED' }) });
  await loading;
  assert.equal(f.node('rightPanel').classList.contains('open'), false);
  assert.equal(f.window._currentDetailId, null);
  assert.equal(f.messages.length, 0);
});

function teamCard(assignment) {
  const window = { addEventListener() {} };
  vm.runInNewContext(read('public/js/standard-job-team.js'), { window, document: { createElement: () => ({}), head: { append() {} } }, location: { pathname: '/fixture' } });
  return window.RACSJobTeams.bookingTeamCard(assignment);
}
test('the team card identifies the current technician and escapes staff names', () => {
  const html = teamCard({ _id: assignmentId, technicianId, status: 'en_route', bookingId: { technicianId },
    technicianTeam: [{ technicianId, assignmentId, role: 'primary', name: 'Yachi <img src=x>', status: 'accepted' },
      { technicianId: replacementId, role: 'support', name: 'Supporting technician', status: 'pending' }] });
  assert.match(html, /Service team/);
  assert.match(html, /Yachi &lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /booking-team-you">You/);
  assert.match(html, /Primary technician/);
  assert.match(html, /Awaiting response/);
});
test('cancelled visit cards retain the old technician and do not display the replacement crew', () => {
  const html = teamCard({ _id: assignmentId, technicianId, status: 'cancelled',
    bookingId: { technicianId: replacementId, technician: { name: 'Replacement Crew' }, technicianTeam: [{ technicianId: replacementId, assignmentId: id(6), name: 'Replacement Crew', status: 'accepted' }] } });
  assert.match(html, /Visit team/);
  assert.match(html, /Cancelled/);
  assert.doesNotMatch(html, /Replacement Crew/);
  assert.doesNotMatch(html, />Accepted</);
});
test('emergency visit history retains the entire previous crew after current staffing is cleared', () => {
  const html = teamCard({ _id: assignmentId, technicianId, status: 'cancelled', bookingId: {
    technicianId: null, staffingEmergencies: [{ team: [{ technicianId, assignmentId, name: 'Yachi 123', role: 'primary' },
      { technicianId: replacementId, assignmentId: id(8), name: 'Previous supporting technician', role: 'support' }] }] } });
  assert.match(html, /2 technicians/);
  assert.match(html, /Yachi 123/);
  assert.match(html, /Previous supporting technician/);
});
test('both primary and supporting technicians receive the emergency action before work starts', () => {
  const window = { addEventListener() {} };
  vm.runInNewContext(read('public/js/standard-job-team.js'), { window, document: { createElement: () => ({}), head: { append() {} } }, location: { pathname: '/fixture' } });
  for (const crewRole of ['primary', 'support']) for (const status of ['accepted', 'en_route', 'on_site']) {
    const assignment = { _id: assignmentId, crewRole, status, customerName: 'A "customer"', serviceName: 'Aircon Installation', bookingId: { status: 'on-the-way' } };
    assert.match(window.RACSJobTeams.emergencyAction(assignment), /Report Emergency/);
    if (crewRole === 'support') assert.match(window.RACSJobTeams.assignmentActions(assignment), /Report Emergency/);
  }
  assert.equal(window.RACSJobTeams.emergencyAction({ _id: assignmentId, status: 'accepted', bookingId: { status: 'in-progress' } }), '');
});
test('admin emergency notice escapes the report and stops describing an already replaced crew as paused', () => {
  const window = { addEventListener() {} };
  vm.runInNewContext(read('public/js/standard-job-team.js'), { window, document: { createElement: () => ({}), head: { append() {} } }, location: { pathname: '/fixture' } });
  const booking = { status: 'pending_reassignment', technicianId: null, staffingEmergencies: [{ reporterName: 'Yachi <img>', reporterRole: 'support', reason: '<script>test</script>',
    team: [{ technicianId, assignmentId, name: 'Yachi <img>', role: 'support', equipmentCheckedOut: true }] }] };
  const html = window.RACSJobTeams.emergencyNotice(booking, { admin: true });
  assert.match(html, /Yachi &lt;img&gt;/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /Kit issued/); assert.match(html, /Supporting/);
  assert.equal(window.RACSJobTeams.emergencyNotice({ ...booking, technicianId: replacementId }, { admin: true }), '');
  assert.equal(window.RACSJobTeams.emergencyNotice({ ...booking, status: 'confirmed' }, { admin: true }), '');
});
