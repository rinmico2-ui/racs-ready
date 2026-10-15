"use strict";

const path = require("node:path");
const recovery = require("./resetRecoveryBackup");

const OPERATION = "expense-data-cleanup-20261015-v1";
const ids = rows => rows.map(row => row._id);
const amount = rows => Math.round(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100;

async function read(db, name, filter, session) {
  const rows = await db.collection(name).find(filter, { session }).sort({ _id: 1 }).limit(50001).maxTimeMS(15000).toArray();
  if (rows.length > 50000) throw Error("Expense cleanup exceeds the supported record limit. No changes made.");
  return rows;
}

async function snapshot(db, session, selectedIds) {
  const expenses = await read(db, "expenses", selectedIds ? { _id: { $in: selectedIds } } : {}, session);
  const notifications = expenses.length ? await read(db, "notifications", { referenceModel: "Expense", referenceId: { $in: ids(expenses) } }, session) : [];
  return { remove: { expenses, notifications } };
}

function plan(data) {
  const expenses = data.remove.expenses;
  const statuses = [...new Set(expenses.map(row => String(row.status || "unknown")))].sort();
  return { mode: "dry-run", operation: OPERATION, scope: "All current expense entries, including approved, pending and rejected, and their linked Expense notifications only.",
    expenseRecords: expenses.length, linkedNotifications: data.remove.notifications.length, totalExpenseAmount: amount(expenses),
    byStatus: Object.fromEntries(statuses.map(status => {
      const rows = expenses.filter(row => String(row.status || "unknown") === status);
      return [status, { count: rows.length, amount: amount(rows) }];
    })),
    preserved: ["payroll", "POS sales and product costs", "bookings and orders", "inventory", "employees and accounts", "attendance and salary rates", "receipt files", "security and financial audit history"],
    note: "Report impact depends on the selected dates and whether costs are also recorded on a job. Product costs and remaining payroll still affect profit. Maintenance mode is unchanged.",
  };
}

async function requireTransactions(db) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw Error("Expense cleanup requires a MongoDB replica set or sharded cluster. No standalone fallback is allowed.");
}

function validateBackup(artifact, db) {
  if (artifact.operation !== OPERATION || Number(artifact.schemaVersion) !== 1 || artifact.database !== db.databaseName
    || Number(artifact.snapshotDigestVersion) !== 2 || !Array.isArray(artifact.original?.remove?.expenses)
    || !Array.isArray(artifact.original?.remove?.notifications) || Object.keys(artifact.original).some(name => name !== "remove")
    || Object.keys(artifact.original.remove).some(name => !["expenses", "notifications"].includes(name))) {
    throw Error("This is not a supported expense recovery backup for this database.");
  }
}

async function cleanupExpenses({ db, client, apply = false, backupDirectory, now = new Date() }) {
  if (await db.collection("sitesettings").findOne({ key: OPERATION })) return { mode: "already-applied", operation: OPERATION, message: "This expense cleanup already ran. Later expenses will not be deleted." };
  const original = await snapshot(db), summary = plan(original);
  if (!apply) return { ...summary, databaseChanges: 0 };
  if (!summary.expenseRecords) return { ...summary, mode: "nothing-to-delete", databaseChanges: 0 };
  await requireTransactions(db);
  const prepared = await recovery.writeResetBackup({ schemaVersion: 1, operation: OPERATION, database: db.databaseName, preparedAt: now, original, seed: {} }, backupDirectory, { namePrefix: "expense-reset" });
  const { artifact } = await recovery.readResetBackup(prepared.backup);
  validateBackup(artifact, db);
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      if (await db.collection("sitesettings").findOne({ key: OPERATION }, { session })) throw Error("Expense cleanup completed in another session. No later expenses were deleted.");
      const current = await snapshot(db, session, ids(original.remove.expenses));
      if (recovery.digest(current) !== artifact.originalSnapshotHash) throw Error("Expenses or their notifications changed after backup. All changes were rolled back; run again for a fresh backup.");
      for (const [name, rows] of Object.entries(current.remove)) if (rows.length) {
        const deleted = await db.collection(name).deleteMany({ _id: { $in: ids(rows) } }, { session });
        if (deleted.deletedCount !== rows.length) throw Error("Expense records changed; all changes were rolled back.");
      }
      await db.collection("sitesettings").insertOne({ key: OPERATION, value: { appliedAt: now, backupSha256: prepared.backupSha256, expenseRecords: summary.expenseRecords }, createdAt: now, updatedAt: now }, { session });
      await db.collection("activitylogs").insertOne({ action: "EXPENSE_DATA_REMOVED", actionType: "system", source: "system", actorName: "Owner-authorized expense cleanup", outcome: "success", createdAt: now,
        details: { operation: OPERATION, expenseRecords: summary.expenseRecords, linkedNotifications: summary.linkedNotifications, byStatus: summary.byStatus,
          backup: path.basename(prepared.backup), backupSha256: prepared.backupSha256 } }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15000 });
  } catch (error) { error.message += ` Verified recovery backup retained at ${prepared.backup}.`; throw error; }
  finally { await session.endSession(); }
  return { ...summary, ...prepared, mode: "deleted", atomic: true, message: "Backed-up expenses and their linked expense notifications were deleted. Payroll, POS sales, inventory, staff, receipts and audit history were preserved. Allow 30 seconds for report caches, then refresh." };
}

async function restoreExpenses({ db, client, backupFile, now = new Date() }) {
  const { artifact, backupSha256 } = await recovery.readResetBackup(backupFile);
  validateBackup(artifact, db);
  const marker = await db.collection("sitesettings").findOne({ key: OPERATION });
  if (!marker || marker.value.backupSha256 !== backupSha256) throw Error("This backup does not match the applied expense cleanup.");
  if (marker.value.restoredAt) return { mode: "already-restored", operation: OPERATION };
  await requireTransactions(db);
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const currentMarker = await db.collection("sitesettings").findOne({ key: OPERATION }, { session });
      if (!currentMarker || currentMarker.value.backupSha256 !== backupSha256 || currentMarker.value.restoredAt) throw Error("Expense recovery state changed. No records were overwritten.");
      for (const [name, rows] of Object.entries(artifact.original.remove)) {
        if (rows.length && await db.collection(name).findOne({ _id: { $in: ids(rows) } }, { session })) throw Error("An expense recovery ID already exists. No records were overwritten.");
      }
      for (const [name, rows] of Object.entries(artifact.original.remove)) if (rows.length) await db.collection(name).insertMany(rows, { session });
      await db.collection("sitesettings").updateOne({ key: OPERATION }, { $set: { value: { ...currentMarker.value, restoredAt: now }, updatedAt: now } }, { session });
      await db.collection("activitylogs").insertOne({ action: "EXPENSE_DATA_RESTORED", actionType: "system", source: "system", actorName: "Owner-authorized expense recovery", outcome: "success", createdAt: now,
        details: { operation: OPERATION, expenseRecords: artifact.original.remove.expenses.length, backupSha256 } }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15000 });
  } finally { await session.endSession(); }
  return { mode: "restored", operation: OPERATION, expenseRecords: artifact.original.remove.expenses.length, atomic: true };
}

module.exports = { OPERATION, snapshot, plan, cleanupExpenses, restoreExpenses };
