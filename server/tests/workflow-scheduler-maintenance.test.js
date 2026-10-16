"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const SiteSetting = require('../models/SiteSetting');
const settings = require('../utils/systemConfiguration');
const gate = require('../utils/workflowSchedulerMaintenance');

function maintenanceSetting(t) {
  const find = SiteSetting.findOne;
  let enabled = false, failure = false, reads = 0;
  SiteSetting.findOne = () => ({ async lean() {
    reads++;
    if (failure) throw Error('Settings unavailable');
    return { value: { maintenance: { enabled } } };
  } });
  settings.invalidateSystemConfiguration();
  t.after(() => { SiteSetting.findOne = find; settings.invalidateSystemConfiguration(); });
  return { set enabled(value) { enabled = value; }, set failure(value) { failure = value; }, get reads() { return reads; } };
}

test('scheduled writes observe a maintenance change on another instance despite a cached HTTP setting', async t => {
  const state = maintenanceSetting(t);
  await settings.getSystemConfiguration();
  state.enabled = true;
  let writes = 0;
  const result = await gate.runWorkflowScheduledTask(async () => { writes++; });
  assert.equal(result.pausedForMaintenance, true); assert.equal(writes, 0);
  state.enabled = false;
  await gate.runWorkflowScheduledTask(async () => { writes++; });
  assert.equal(writes, 1); assert.equal(state.reads, 3);
});

test('scheduled writes do not run when the maintenance setting cannot be read', async t => {
  const state = maintenanceSetting(t); state.failure = true;
  let writes = 0;
  await assert.rejects(gate.runWorkflowScheduledTask(async () => { writes++; }), /Settings unavailable/);
  assert.equal(writes, 0);
});

// Exercise the real scheduler callbacks with fake timers and workflow operations,
// so no booking, kit or customer notification is written by these tests.
for (const [file, name, marker] of [
  ['overdueBookingScheduler', 'startOverdueScheduler', 'let overdueSchedulerStarted = false;'],
  ['maintenanceScheduler', 'startMaintenanceScheduler'],
  ['equipmentReturnScheduler', 'startEquipmentReturnScheduler'],
  ['assignmentExpiry', 'startAssignmentExpiryScheduler'],
  ['delayNotifier', 'startDelayMonitor'],
]) {
  test(`${name} pauses its timer callbacks and resumes without restarting the application`, async t => {
    const state = maintenanceSetting(t), callbacks = [];
    let writes = 0;
    const task = async () => { writes++; };
    const source = fs.readFileSync(path.join(__dirname, `../utils/${file}.js`), 'utf8');
    const start = source.indexOf(marker || `function ${name}(`);
    const end = source.indexOf('\nmodule.exports', start);
    assert.ok(start >= 0);
    const schedule = callback => { callbacks.push(callback); return { unref() {} }; };
    const context = vm.createContext({
      require(request) { assert.equal(request, './workflowSchedulerMaintenance'); return gate; },
      console: { log() {}, error() {} }, CHECK_INTERVAL_MS: 60000, timer: null,
      setTimeout: schedule, setInterval: schedule, clearInterval() {},
      checkForUnassignedOverdueBookings: task, checkForDelayedBookings: task,
      checkForServiceDelays: task, checkForUpcomingUnverifiedBookings: task,
      checkForCustomerServiceReminders: task, checkMaintenanceReminders: task,
      checkOverdueEquipmentReturns: task, processAssignmentExpiry: task,
      ACTIVE_STATUSES: ['in-progress'],
      BookingService: { find() { writes++; return { select() { return { lean: async () => [] }; } }; } },
    });
    vm.runInContext(source.slice(start, end < 0 ? undefined : end), context);
    context[name]();
    assert.ok(callbacks.length);
    state.enabled = true;
    for (const callback of callbacks) await callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 0);
    state.enabled = false;
    await callbacks[callbacks.length - 1]();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(writes > 0);
  });
}
