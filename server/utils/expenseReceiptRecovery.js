"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const Expense = require("../models/Expense");
const Technician = require("../models/Technician");
const storage = require("./financialReceiptStorage");
const locks = require("./operationLock");

function receiptReference(value) {
  if (typeof value !== "string") return null;
  const legacy = value.match(/^\/uploads\/expense-receipts\/(expense-\d+-\d+\.(?:jpe?g|png|webp|pdf))$/i);
  if (legacy) return { url: value, filename: legacy[1] };
  const saved = value.match(/^\/api\/receipts\/([a-f0-9]{24})$/i);
  return saved ? { url: `/api/receipts/${saved[1].toLowerCase()}`, fileId: saved[1] } : null;
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
async function recoverExpenseReceipt({ expenseId, file, confirmOriginal, user }) {
  if (user?.role !== "admin") fail(403, "Only an administrator can restore a missing receipt.");
  if (!/^[a-f0-9]{24}$/i.test(String(expenseId || ""))) fail(400, "Choose a valid expense.");
  if (confirmOriginal !== true && confirmOriginal !== "true") fail(400, "Confirm that this is the original receipt for this expense.");
  storage.receiptType(file);
  const expense = await Expense.findById(expenseId).select("receiptImage technicianId recordedBy").lean();
  if (!expense) fail(404, "Expense not found.");
  const reference = receiptReference(expense.receiptImage);
  if (!reference) fail(400, "This receipt reference requires assistance from the server administrator.");
  return locks.withOperationLock(`expense-receipt-recovery:${reference.url}`, async () => {
    const current = await Expense.findById(expenseId).select("receiptImage").lean();
    if (!current || receiptReference(current.receiptImage)?.url !== reference.url) fail(409, "The expense receipt reference changed. Refresh the expense before restoring its receipt.");
    const existing = reference.filename ? await storage.findLegacyFinancialReceipt(reference.filename) : await storage.findFinancialReceipt(reference.fileId);
    if (existing) return { repeated: true, url: reference.url };
    if (reference.filename) {
      try {
        const original = await fs.stat(path.join(__dirname, "../public/uploads/expense-receipts", reference.filename));
        if (original.isFile()) fail(409, "The original receipt is already present. Refresh its preview instead.");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const technician = expense.technicianId ? await Technician.findById(expense.technicianId).select("user").lean() : null;
    const owner = expense.recordedBy || technician?.user || user._id;
    const restoredAt = new Date();
    const saved = await storage.storeFinancialReceipt(file, owner, { metadata: {
      ...(reference.filename ? { legacyPath: reference.url } : { recoveredFrom: reference.url }),
      expenseId: String(expense._id), restoredBy: String(user._id), restoredAt,
      sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
      originalConfirmed: true,
    } });
    // The old reference continues to resolve. Amounts, approvals and linked
    // purchase records are never rewritten by receipt restoration.
    return { repeated: false, url: reference.url, fileId: String(saved.fileId) };
  }, { waitMs: 3000, leaseMs: 45000 });
}
module.exports = { receiptReference, recoverExpenseReceipt };
