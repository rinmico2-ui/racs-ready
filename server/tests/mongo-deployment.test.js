"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { describeMongoDeployment, inspectMongoDeployment } = require("../utils/mongoDeployment");

test("a connected standalone primary with sessions still cannot provide transactions", () => {
  const result = describeMongoDeployment({ isWritablePrimary: true, logicalSessionTimeoutMinutes: 30, maxWireVersion: 25 });
  assert.deepEqual(result, { topology: "standalone", replicaSet: null, writablePrimary: true, transactionsConfigured: false });
});

test("replica sets need session support and MongoDB 4.0 or later for transactions", () => {
  const hello = { setName: "rs0", isWritablePrimary: true, logicalSessionTimeoutMinutes: 30, maxWireVersion: 7 };
  assert.equal(describeMongoDeployment(hello).transactionsConfigured, true);
  assert.equal(describeMongoDeployment({ ...hello, maxWireVersion: 6 }).transactionsConfigured, false);
  assert.equal(describeMongoDeployment({ ...hello, logicalSessionTimeoutMinutes: undefined }).transactionsConfigured, false);
  assert.equal(describeMongoDeployment({ ...hello, isWritablePrimary: false }).writablePrimary, false);
});

test("sharded deployments need MongoDB 4.2 or later for transactions", () => {
  const hello = { msg: "isdbgrid", logicalSessionTimeoutMinutes: 30, maxWireVersion: 8, ismaster: true };
  assert.equal(describeMongoDeployment(hello).topology, "sharded");
  assert.equal(describeMongoDeployment(hello).transactionsConfigured, true);
  assert.equal(describeMongoDeployment({ ...hello, maxWireVersion: 7 }).transactionsConfigured, false);
});

test("deployment inspection issues only a hello metadata command", async () => {
  const commands = [];
  const result = await inspectMongoDeployment({ db: { admin: () => ({ command: async command => {
    commands.push(command);
    return { setName: "rs0", maxWireVersion: 25, logicalSessionTimeoutMinutes: 30, isWritablePrimary: true };
  } }) } });
  assert.deepEqual(commands, [{ hello: 1 }]);
  assert.equal(result.transactionsConfigured, true);
});

test("older MongoDB metadata commands are supported without hiding connection or permission failures", async () => {
  const commands = [];
  const result = await inspectMongoDeployment({ db: { admin: () => ({ command: async command => {
    commands.push(command);
    if (command.hello) throw Object.assign(new Error("hello unavailable"), { code: 59 });
    return { ismaster: true, maxWireVersion: 6, logicalSessionTimeoutMinutes: 30 };
  } }) } });
  assert.deepEqual(commands, [{ hello: 1 }, { isMaster: 1 }]);
  assert.equal(result.transactionsConfigured, false);
  await assert.rejects(inspectMongoDeployment({ db: { admin: () => ({ command: async () => {
    throw Object.assign(new Error("Unauthorized"), { code: 13 });
  } }) } }), /Unauthorized/);
});
