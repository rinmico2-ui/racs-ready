"use strict";

// hello is a read-only server metadata command. It verifies the deployment
// shape without testing writes against business records.
function describeMongoDeployment(hello = {}) {
  const topology = hello.msg === "isdbgrid" ? "sharded"
    : hello.setName ? "replica_set" : "standalone";
  const sessionSupport = typeof hello.logicalSessionTimeoutMinutes === "number";
  const minimumWireVersion = topology === "sharded" ? 8 : 7;
  return {
    topology,
    replicaSet: typeof hello.setName === "string" ? hello.setName : null,
    writablePrimary: hello.isWritablePrimary === true || hello.ismaster === true,
    transactionsConfigured: topology !== "standalone" && sessionSupport
      && Number(hello.maxWireVersion) >= minimumWireVersion,
  };
}

async function inspectMongoDeployment(connection) {
  const admin = connection.db.admin();
  let hello;
  try { hello = await admin.command({ hello: 1 }); }
  catch (error) {
    if (error.code !== 59 && error.codeName !== "CommandNotFound") throw error;
    hello = await admin.command({ isMaster: 1 });
  }
  return describeMongoDeployment(hello);
}

module.exports = { describeMongoDeployment, inspectMongoDeployment };
