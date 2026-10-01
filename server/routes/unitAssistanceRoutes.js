const express = require('express');
const mongoose = require('mongoose');
const { rateLimit } = require('express-rate-limit');
const auth = require('../middleware/authenticate');
const { authenticatedOrIpKey } = require('../utils/rateLimitIdentity');
const CoreService = require('../models/CoreService');
const BookingService = require('../models/BookingService');
const UnitAssistanceRequest = require('../models/UnitAssistanceRequest');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');
const { createNotification } = require('../utils/notify');

const router = express.Router();
router.use(auth.authenticate);
const customer = auth.requireRole('customer');
const staff = auth.requireRole(['admin', 'secretary']);
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyGenerator: authenticatedOrIpKey, standardHeaders: true, legacyHeaders: false });
const validId = id => mongoose.isValidObjectId(id);
const customerFields = '_id serviceId serviceName existingBookingId existingBookingReference brand airconType hp quantity notes status createdAt quote.brand quote.airconType quote.airconTypeName quote.hp quote.unitPrice quote.durationMinutes quote.notes quote.quotedAt quote.expiresAt';

router.post('/', customer, limiter, async (req, res) => {
  try {
    const serviceId = String(req.body.serviceId || '');
    const quantity = Number(req.body.quantity);
    if (!validId(serviceId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 40) {
      return res.status(400).json({ error: 'Choose a valid service and unit quantity.' });
    }
    const catalog = await CoreService.findOne({ _id: serviceId, active: true }).lean();
    if (!catalog?.isAirconService || !(catalog.airconTypes?.length || catalog.hpPricing?.length)) {
      return res.status(400).json({ error: 'Unit identification is unavailable for this service.' });
    }
    const brand = String(req.body.brand || '').trim().slice(0, 80);
    const airconType = String(req.body.airconType || '').trim();
    const hp = req.body.hp == null || req.body.hp === '' ? null : Number(req.body.hp);
    if (airconType && !catalog.airconTypes?.some(type => type.type === airconType)) {
      return res.status(400).json({ error: 'Choose a supported aircon type.' });
    }
    if (hp !== null && (!Number.isFinite(hp) || hp <= 0)) return res.status(400).json({ error: 'Invalid HP.' });
    if (brand && brand.toLowerCase() !== "i don't know" && airconType && hp != null) {
      return res.status(400).json({ error: 'All unit details are known. Continue with the regular booking.' });
    }
    let existingBooking = null;
    if (req.body.existingBookingId) {
      if (!validId(req.body.existingBookingId)) return res.status(400).json({ error: 'Invalid existing booking.' });
      existingBooking = await BookingService.findOne({ _id: req.body.existingBookingId, customerId: req.user._id })
        .select('_id bookingReference status').lean();
      if (!existingBooking || ['completed', 'cancelled', 'rejected', 'closed'].includes(existingBooking.status)) {
        return res.status(409).json({ error: 'This booking is no longer open for a service change.' });
      }
    }
    const request = await UnitAssistanceRequest.create({
      customerId: req.user._id, serviceId, serviceName: catalog.name,
      existingBookingId: existingBooking?._id || null,
      existingBookingReference: existingBooking?.bookingReference || '',
      brand, airconType, hp, quantity,
      notes: String(req.body.notes || '').trim().slice(0, 1000),
      events: [{ action: 'requested', actorId: req.user._id, notes: String(req.body.notes || '').trim().slice(0, 1000) }],
    });
    for (const role of ['admin', 'secretary']) {
      createNotification({ type: 'system', role, title: 'Unit identification requested',
        message: `${catalog.name}: customer needs help identifying an aircon${existingBooking ? ` for booking ${existingBooking.bookingReference}` : ' before booking'}.`,
        link: `/${role}/unit-assistance`, priority: 'normal', io: req.app.get('io') }).catch(() => {});
    }
    return res.status(201).json({ id: request._id, status: request.status });
  } catch (error) {
    console.error('Unit assistance request failed:', error);
    return res.status(500).json({ error: 'Could not submit your request. Please try again.' });
  }
});

router.get('/mine', customer, async (req, res) => {
  const requests = await UnitAssistanceRequest.find({ customerId: req.user._id }).select(customerFields).sort({ createdAt: -1 }).limit(50).lean();
  return res.json({ requests });
});

router.get('/mine/:id', customer, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  const request = await UnitAssistanceRequest.findOne({ _id: req.params.id, customerId: req.user._id }).select(customerFields).lean();
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  return res.json({ request });
});

router.post('/mine/:id/decision', customer, async (req, res) => {
  if (!validId(req.params.id) || !['accept', 'decline'].includes(req.body.decision)) {
    return res.status(400).json({ error: 'Invalid decision.' });
  }
  const request = await UnitAssistanceRequest.findOne({ _id: req.params.id, customerId: req.user._id, status: 'quoted' });
  if (!request) return res.status(409).json({ error: 'This quote is no longer available.' });
  if (!request.quote?.expiresAt || request.quote.expiresAt <= new Date()) return res.status(409).json({ error: 'This quote expired. Contact the store for a new quote.' });
  const status = req.body.decision === 'accept' ? 'accepted' : 'declined';
  const updated = await UnitAssistanceRequest.findOneAndUpdate({ _id: request._id, status: 'quoted',
    'quote.quotedAt': request.quote.quotedAt, 'quote.expiresAt': { $gt: new Date() } }, {
    $set: { status, ...(status === 'accepted' ? { acceptedAt: new Date() } : {}) },
    $push: { events: { action: status, actorId: req.user._id, unitPrice: request.quote.unitPrice } },
  }, { new: true });
  if (!updated) return res.status(409).json({ error: 'This quote has already been decided.' });
  if (status === 'accepted' && updated.existingBookingId) {
    for (const role of ['admin', 'secretary']) {
      createNotification({ type: 'system', role, title: 'Unit quote accepted for existing booking',
        message: `Customer accepted a unit quote for ${updated.existingBookingReference}. Review the service change and any payment adjustment.`,
        link: `/${role}/unit-assistance`, priority: 'high', io: req.app.get('io') }).catch(() => {});
    }
  }
  return res.json({ status: updated.status });
});

router.get('/staff', staff, async (req, res) => {
  const requests = await UnitAssistanceRequest.find({ status: { $in: ['pending', 'quoted', 'accepted'] } })
    .populate('customerId', 'firstName lastName email phone mobile')
    .populate('serviceId', 'name airconTypes hpPricing active')
    .sort({ createdAt: -1 }).limit(100).lean();
  return res.json({ requests });
});

router.post('/staff/:id/quote', staff, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
    const request = await UnitAssistanceRequest.findOne({ _id: req.params.id, status: { $in: ['pending', 'quoted', 'accepted'] } });
    if (!request) return res.status(409).json({ error: 'This request is no longer open.' });
    const catalog = await CoreService.findOne({ _id: request.serviceId, active: true }).lean();
    const verificationMethod = String(req.body.verificationMethod || '');
    if (!['customer_contact', 'model_label', 'site_visit'].includes(verificationMethod)) {
      return res.status(400).json({ error: 'Select how the unit details were verified.' });
    }
    const brand = String(req.body.brand || request.brand || '').trim().slice(0, 80);
    const selection = { brand, airconType: req.body.airconType, hp: req.body.hp, quantity: request.quantity };
    const pricing = resolveCoreServicePricing(catalog, selection);
    const quote = {
      brand, airconType: pricing.airconType, airconTypeName: pricing.airconTypeName,
      hp: pricing.hp, unitPrice: pricing.unitPrice, durationMinutes: pricing.duration,
      notes: String(req.body.notes || '').trim().slice(0, 1000),
      verificationMethod,
      quotedBy: req.user._id, quotedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
    const updated = await UnitAssistanceRequest.findOneAndUpdate({ _id: request._id, status: request.status, bookingId: null },
      { $set: { quote, status: 'quoted', acceptedAt: null },
        $push: { events: { action: 'quoted', actorId: req.user._id, unitPrice: pricing.unitPrice, notes: quote.notes } } }, { new: true });
    if (!updated) return res.status(409).json({ error: 'This request was updated. Reload the queue.' });
    createNotification({ type: 'system', userId: updated.customerId,
      title: 'Your aircon service quote is ready',
      message: `Review the identified unit and price for ${updated.serviceName}.`,
      link: '/unit-assistance', priority: 'high', io: req.app.get('io') }).catch(() => {});
    return res.json({ request: updated });
  } catch (error) {
    if (error.message && !error.name?.includes('Mongo')) return res.status(400).json({ error: error.message });
    console.error('Unit assistance quote failed:', error);
    return res.status(500).json({ error: 'Could not save the quote.' });
  }
});

router.post('/staff/:id/resolve', staff, async (req, res) => {
  if (!validId(req.params.id) || req.body.confirmed !== true) return res.status(400).json({ error: 'Confirm that the booking and payment adjustment were handled.' });
  const notes = String(req.body.notes || '').trim().slice(0, 1000);
  if (notes.length < 10) return res.status(400).json({ error: 'Record how the existing booking was handled.' });
  const updated = await UnitAssistanceRequest.findOneAndUpdate({
    _id: req.params.id, status: 'accepted', existingBookingId: { $ne: null },
  }, { $set: { status: 'resolved', resolvedBy: req.user._id, resolvedAt: new Date(), resolutionNotes: notes },
    $push: { events: { action: 'resolved', actorId: req.user._id, notes } } }, { new: true });
  if (!updated) return res.status(409).json({ error: 'This request is no longer awaiting resolution.' });
  createNotification({ type: 'system', userId: updated.customerId,
    title: 'Your unit request was handled', message: `Staff updated the request for ${updated.existingBookingReference}. Review your booking history.`,
    link: '/book-history', priority: 'normal', io: req.app.get('io') }).catch(() => {});
  return res.json({ status: updated.status });
});

module.exports = router;
