const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/authenticate');
const RelocationRequest = require('../models/RelocationRequest');

const router = express.Router();
router.use(auth.authenticate);
const customer = auth.requireRole('customer');
const staff = auth.requireRole(['admin', 'secretary']);
const validId = id => mongoose.isValidObjectId(id);
const ownFields = '_id serviceId assetId bookingId scope from to unit preferredDate notes status assessmentNotes quote.lines quote.total quote.durationMinutes quote.notes quote.version quote.quotedAt quote.expiresAt acceptedAt createdAt';

function retiredQuotation(req, res) {
  return res.status(410).json({ error: 'Relocation is now booked through the normal service booking, with locations, schedule and payment.', code: 'RELOCATION_NORMAL_BOOKING', bookingUrl: '/services' });
}

router.post('/', customer, retiredQuotation);

router.get('/mine', customer, async (req, res) => {
  const requests = await RelocationRequest.find({ customerId: req.user._id }).select(ownFields).sort({ createdAt: -1 }).limit(50).lean();
  return res.json({ requests });
});

router.get('/mine/:id', customer, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  const request = await RelocationRequest.findOne({ _id: req.params.id, customerId: req.user._id }).select(ownFields).lean();
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  return res.json({ request });
});

router.post('/mine/:id/decision', customer, retiredQuotation);

router.get('/staff', staff, async (req, res) => {
  const requests = await RelocationRequest.find({ status: { $in: ['pending_review', 'assessment_needed', 'quoted', 'accepted', 'converted'] } })
    .populate('customerId', 'firstName lastName email phone mobile')
    .sort({ createdAt: -1 }).limit(100).lean();
  return res.json({ requests });
});

router.post('/staff/:id/assessment', staff, retiredQuotation);
router.post('/staff/:id/quote', staff, retiredQuotation);

module.exports = router;
