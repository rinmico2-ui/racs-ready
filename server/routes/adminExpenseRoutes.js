'use strict';
const express = require('express');
const multer = require('multer');
const { requireRole } = require('../middleware/authenticate');
const service = require('../utils/adminExpenseService').createService();
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 16 } }).single('receipt');
router.get('/options', requireRole(['admin']), async (req, res, next) => {
  try {
    const [technicians, bookings] = await Promise.all([
      require('../models/Technician').find({ active: { $ne: false }, archivedAt: null }).select('name').sort({ name: 1 }).limit(200).lean(),
      require('../models/BookingService').find({ archivedAt: null }).select('bookingReference customer.name service.name services.name').sort({ createdAt: -1 }).limit(100).lean(),
    ]);
    res.set('Cache-Control', 'private, no-store').json({ technicians, bookings });
  } catch (error) { next(error); }
});
router.post('/', requireRole(['admin']), (req, res, next) => upload(req, res, async error => {
  if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Receipt must be 5 MB or smaller.' : 'Choose one valid receipt file.' });
  try {
    const result = await service.create({ input: req.body, file: req.file, user: req.user });
    if (!result.repeated) await require('../utils/audit').logEvent({ actor: req.user._id, target: result.expense._id, action: 'expense.create', module: 'admin', req, details: { amount: result.expense.amount, type: result.expense.type, source: 'admin', status: 'approved' } }).catch(() => {});
    return res.status(result.repeated ? 200 : 201).json({ ...result, success: true, message: 'Expense saved as approved.' });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
}));
module.exports = router;
