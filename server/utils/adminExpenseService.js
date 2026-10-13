'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const { strictManilaDateKey, manilaDateKey, manilaDateTime } = require('./bookingDateTime');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const TYPES = ['fuel', 'parking', 'toll', 'external_parts', 'meal', 'other', 'material', 'transport'];
function createService(overrides = {}) {
  const m = { Expense: require('../models/Expense'), Technician: require('../models/Technician'), BookingService: require('../models/BookingService'), storage: require('./financialReceiptStorage'), ...overrides };
  async function create({ input, file, user, now = new Date() }) {
    if (user?.role !== 'admin') throw fail('Only admin can add expenses here.', 403);
    if (!TYPES.includes(input.type)) throw fail('Choose a valid expense type.');
    const rawAmount = String(input.amount ?? ''), amount = Number(rawAmount);
    if (!/^\d+(?:\.\d{1,2})?$/.test(rawAmount) || !Number.isFinite(amount) || amount < 0.01 || amount > 1000000000) throw fail('Enter an amount greater than zero, with up to two decimal places.');
    if (typeof input.description !== 'string' || !input.description.trim() || input.description.trim().length > 500) throw fail('Enter a description of up to 500 characters.');
    const dateKey = typeof input.expenseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate) ? strictManilaDateKey(input.expenseDate) : '';
    if (!dateKey || dateKey > manilaDateKey(now)) throw fail('Choose a valid expense date, today or earlier.');
    for (const field of ['technicianId', 'bookingId']) if (input[field] && !mongoose.isValidObjectId(input[field])) throw fail('Choose a valid technician or booking.');
    if (typeof input.submissionKey !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(input.submissionKey)) throw fail('Reopen the form and try again.');
    m.storage.receiptType(file);
    const fields = { type: input.type, amount, description: input.description.trim(), expenseDate: manilaDateTime(dateKey, 0), technicianId: input.technicianId || null, bookingId: input.bookingId || null };
    if (input.type === 'fuel') {
      for (const key of ['fuelLiters', 'pricePerLiter', 'odometerReading']) {
        const value = Number(input[key]);
        if (!Number.isFinite(value) || value <= 0) throw fail('Enter valid fuel litres, price per litre, and odometer reading.');
        fields[key] = value;
      }
      if (typeof input.gasStation !== 'string' || !input.gasStation.trim() || input.gasStation.trim().length > 200) throw fail('Enter the gas station name, up to 200 characters.');
      fields.gasStation = input.gasStation.trim();
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(fields)).update(file.buffer).digest('hex');
    // Use MongoDB's built-in unique _id index to prevent retries from creating
    // duplicates. Each form token is scoped to the signed-in administrator.
    const expenseId = new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`admin-expense:${user._id}:${input.submissionKey}`).digest('hex').slice(0, 24));
    const existing = async () => {
      const record = await m.Expense.findById(expenseId).select('+submissionFingerprint').lean();
      if (!record) return null;
      if (record.source !== 'admin' || String(record.recordedBy) !== String(user._id) || record.submissionFingerprint !== fingerprint) throw fail('This form was already saved with different details. Reopen it to add another expense.', 409);
      delete record.submissionFingerprint;
      return { expense: record, repeated: true };
    };
    const saved = await existing(); if (saved) return saved;
    if (fields.technicianId) {
      const technician = await m.Technician.findOne({ _id: fields.technicianId, active: { $ne: false }, archivedAt: null }).select('name').lean();
      if (!technician) throw fail('Technician not found or no longer active.', 404);
      fields.technicianName = technician.name;
    }
    if (fields.bookingId && !await m.BookingService.exists({ _id: fields.bookingId, archivedAt: null })) throw fail('Booking not found.', 404);
    const receipt = await m.storage.storeFinancialReceipt(file, user._id);
    try {
      const expense = await m.Expense.create({ _id: expenseId, ...fields, source: 'admin', recordedBy: user._id, recordedByName: user.name || user.email || 'Admin', approvedBy: user._id, approvedAt: now, status: 'approved', receiptImage: receipt.url, submissionFingerprint: fingerprint });
      const record = expense.toObject(); delete record.submissionFingerprint;
      return { expense: record, repeated: false };
    } catch (error) {
      await m.storage.deleteFinancialReceipt(receipt.fileId).catch(() => {});
      if (error.code === 11000) { const saved = await existing(); if (saved) return saved; }
      throw error;
    }
  }
  return { create };
}
module.exports = { createService, TYPES };
