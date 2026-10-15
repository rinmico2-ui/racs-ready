"use strict";

const path = require("node:path");
const recovery = require("./resetRecoveryBackup");

const OPERATION = "paid-payroll-cleanup-20261015-v1";
const ids = rows => rows.map(row => row._id);
const cents = rows => Math.round(rows.reduce((sum, row) => sum + Number(row || 0), 0) * 100) / 100;

async function read(db, name, filter, session) {
  const rows = await db.collection(name).find(filter, { session }).sort({ _id: 1 }).limit(50001).maxTimeMS(15000).toArray();
  if (rows.length > 50000) throw Error("Paid payroll cleanup exceeds the supported record limit. No changes made.");
  return rows;
}

async function snapshot(db, session, selectedIds) {
  const payrolls = await read(db, "payrolls", { status: "paid", ...(selectedIds ? { _id: { $in: selectedIds } } : {}) }, session);
  const payrollIds = ids(payrolls);
  const notifications = payrollIds.length ? await read(db, "notifications", { referenceModel: "Payroll", referenceId: { $in: payrollIds } }, session) : [];
  const deductions = payrollIds.length ? await read(db, "payments", { payrollDeductionId: { $in: payrollIds } }, session) : [];
  return { remove: { payrolls, notifications }, deductions };
}

function plan(data) {
  return {
    mode: "dry-run", operation: OPERATION, scope: "All existing payroll records with status paid, plus their linked payroll notifications only.",
    paidPayrollRecords: data.remove.payrolls.length, linkedNotifications: data.remove.notifications.length,
    grossPayrollRemovedFromReports: cents(data.remove.payrolls.map(row => row.grossPay)),
    netPaidPayroll: cents(data.remove.payrolls.map(row => row.netPay)),
    blockers: data.deductions.length ? [{ code: "linked_payment_deductions_require_review", count: data.deductions.length }] : [],
    preserved: ["draft, approved and voided payroll", "employees and accounts", "attendance", "salary rates and payroll templates", "POS sales and expenses", "payment and security audit history", "upload files"],
    note: "Reports also include approved-but-unpaid payroll and other costs. This does not set profit to zero, refund wages, or move money.",
  };
}

async function requireTransactions(db) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw Error("Paid payroll cleanup requires a MongoDB replica set or sharded cluster. No standalone fallback is allowed.");
}

function validateBackup(artifact, db) {
  if (artifact.operation !== OPERATION || Number(artifact.schemaVersion) !== 1 || artifact.database !== db.databaseName
    || Number(artifact.snapshotDigestVersion) !== 2 || !Array.isArray(artifact.original?.remove?.payrolls)
    || !Array.isArray(artifact.original?.remove?.notifications) || Object.keys(artifact.original.remove).some(name => !["payrolls", "notifications"].includes(name))
    || artifact.original.remove.payrolls.some(row => row.status !== "paid") || artifact.original.deductions?.length) {
    throw Error("This is not a supported paid payroll recovery backup for this database.");
  }
}

async function cleanupPaidPayroll({ db, client, apply = false, backupDirectory, now = new Date() }) {
  const existing = await db.collection("sitesettings").findOne({ key: OPERATION });
  if (existing) return { mode: "already-applied", operation: OPERATION, message: "This cleanup already ran. Later payroll records will not be deleted." };
  const original = await snapshot(db);
  const summary = plan(original);
  if (!apply) return { ...summary, databaseChanges: 0 };
  if (summary.blockers.length) return { ...summary, mode: "blocked", databaseChanges: 0 };
  if (!summary.paidPayrollRecords) return { ...summary, mode: "nothing-to-delete", databaseChanges: 0 };
  await requireTransactions(db);
  const prepared = await recovery.writeResetBackup({ schemaVersion: 1, operation: OPERATION, database: db.databaseName, preparedAt: now, original, seed: {} },
    backupDirectory, { namePrefix: "paid-payroll-reset" });
  const { artifact } = await recovery.readResetBackup(prepared.backup);
  validateBackup(artifact, db);
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      if (await db.collection("sitesettings").findOne({ key: OPERATION }, { session })) throw Error("Paid payroll cleanup already completed in another session. No later payroll was deleted.");
      const current = await snapshot(db, session, ids(original.remove.payrolls));
      if (recovery.digest(current) !== artifact.originalSnapshotHash) throw Error("Paid payroll or its linked records changed after backup. All changes were rolled back; run again to prepare a fresh backup.");
      for (const [name, rows] of Object.entries(current.remove)) if (rows.length) {
        const deleted = await db.collection(name).deleteMany({ _id: { $in: ids(rows) }, ...(name === "payrolls" ? { status: "paid" } : {}) }, { session });
        if (deleted.deletedCount !== rows.length) throw Error("Paid payroll records changed; all changes were rolled back.");
      }
      await db.collection("sitesettings").insertOne({ key: OPERATION, value: { appliedAt: now, backupSha256: prepared.backupSha256, paidPayrollRecords: summary.paidPayrollRecords }, createdAt: now, updatedAt: now }, { session });
      await db.collection("activitylogs").insertOne({ action: "PAID_PAYROLL_TEST_DATA_REMOVED", actionType: "system", source: "system", actorName: "Owner-authorized paid payroll cleanup", outcome: "success", createdAt: now,
        details: { operation: OPERATION, paidPayrollRecords: summary.paidPayrollRecords, linkedNotifications: summary.linkedNotifications,
          grossPayroll: summary.grossPayrollRemovedFromReports, backup: path.basename(prepared.backup), backupSha256: prepared.backupSha256 } }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15000 });
  } catch (error) {
    error.message += ` Verified recovery backup retained at ${prepared.backup}.`;
    throw error;
  } finally { await session.endSession(); }
  return { ...summary, ...prepared, mode: "deleted", atomic: true,
    message: "Paid payroll and its linked payroll notifications were removed. Other payroll, employees, attendance and salary rates were preserved. Maintenance mode was not changed. Allow 30 seconds for report caches, then refresh.",
  };
}

async function restorePaidPayroll({ db, client, backupFile, now = new Date() }) {
  const { artifact, backupSha256 } = await recovery.readResetBackup(backupFile);
  validateBackup(artifact, db);
  const marker = await db.collection("sitesettings").findOne({ key: OPERATION });
  if (!marker || marker.value.backupSha256 !== backupSha256) throw Error("This backup does not match the applied paid payroll cleanup.");
  if (marker.value.restoredAt) return { mode: "already-restored", operation: OPERATION };
  await requireTransactions(db);
  const session = client.startSession();
  const payrolls = artifact.original.remove.payrolls;
  try {
    await session.withTransaction(async () => {
      const activeMarker = await db.collection("sitesettings").findOne({ key: OPERATION }, { session });
      if (!activeMarker || activeMarker.value.backupSha256 !== backupSha256 || activeMarker.value.restoredAt) throw Error("Paid payroll recovery state changed. No records were overwritten.");
      for (const [name, rows] of Object.entries(artifact.original.remove)) {
        if (rows.length && await db.collection(name).findOne({ _id: { $in: ids(rows) } }, { session })) throw Error("Recovery IDs already exist. No records were overwritten.");
      }
      const overlapping = payrolls.length ? await read(db, "payrolls", { employee: { $in: payrolls.map(row => row.employee) }, status: { $ne: "voided" },
        periodStart: { $lte: new Date(Math.max(...payrolls.map(row => Number(row.periodEnd)))) },
        periodEnd: { $gte: new Date(Math.min(...payrolls.map(row => Number(row.periodStart)))) } }, session) : [];
      if (payrolls.some(original => overlapping.some(row => String(row.employee) === String(original.employee)
        && row.periodStart <= original.periodEnd && row.periodEnd >= original.periodStart))) throw Error("A new payroll overlaps a deleted period. Recovery refused instead of replacing newer work.");
      for (const [name, rows] of Object.entries(artifact.original.remove)) if (rows.length) await db.collection(name).insertMany(rows, { session });
      await db.collection("sitesettings").updateOne({ key: OPERATION }, { $set: { value: { ...activeMarker.value, restoredAt: now }, updatedAt: now } }, { session });
      await db.collection("activitylogs").insertOne({ action: "PAID_PAYROLL_TEST_DATA_RESTORED", actionType: "system", source: "system", actorName: "Owner-authorized paid payroll recovery", outcome: "success", createdAt: now,
        details: { operation: OPERATION, paidPayrollRecords: payrolls.length, backupSha256 } }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15000 });
  } finally { await session.endSession(); }
  return { mode: "restored", operation: OPERATION, paidPayrollRecords: payrolls.length, atomic: true };
}

module.exports = { OPERATION, snapshot, plan, cleanupPaidPayroll, restorePaidPayroll };
