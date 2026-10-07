const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/authenticate');
const { rateLimit } = require('../utils/boundedRateLimit');
const { authenticatedOrIpKey } = require('../utils/rateLimitIdentity');
const CoreService = require('../models/CoreService');
const CustomerAsset = require('../models/CustomerAsset');
const RelocationRequest = require('../models/RelocationRequest');
const { createNotification } = require('../utils/notify');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');

const router = express.Router();
router.use(auth.authenticate);
const customer = auth.requireRole('customer');
const staff = auth.requireRole(['admin', 'secretary']);
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyGenerator: authenticatedOrIpKey, standardHeaders: true, legacyHeaders: false });
const clean = (value, max) => String(value || '').trim().slice(0, max);
const validId = id => mongoose.isValidObjectId(id);
const ownFields = '_id serviceId assetId bookingId scope from to unit preferredDate notes status assessmentNotes quote.lines quote.total quote.durationMinutes quote.notes quote.version quote.quotedAt quote.expiresAt acceptedAt createdAt';

router.post('/', customer, limiter, async (req, res) => {
  try {
    if (!validId(req.body.serviceId)) return res.status(400).json({ error: 'Choose Aircon Relocation first.' });
    const service = await CoreService.findOne({ _id: req.body.serviceId, slug: 'aircon-relocation', active: true }).select('_id').lean();
    if (!service) return res.status(400).json({ error: 'Aircon Relocation is unavailable.' });
    if (req.body.scope !== 'custom_quote') return res.status(400).json({ error: 'Use the normal booking for a nearby move on the same property.' });
    const from = { address: clean(req.body.from?.address, 300), details: clean(req.body.from?.details, 500) };
    const to = { address: clean(req.body.to?.address, 300), details: clean(req.body.to?.details, 500) };
    for (const [source, target] of [[req.body.from, from], [req.body.to, to]]) {
      if (source?.lat != null && source?.lng != null) {
        const lat = Number(source.lat), lng = Number(source.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 4 || lat > 22 || lng < 116 || lng > 127) {
          return res.status(400).json({ error: 'Choose both locations within the Philippines.' });
        }
        target.lat = lat;
        target.lng = lng;
      }
    }
    if (from.address.length < 8 || to.address.length < 8) return res.status(400).json({ error: 'Enter both the current and new addresses.' });
    const preferredDate = new Date(req.body.preferredDate);
    if (!Number.isFinite(preferredDate.getTime()) || preferredDate.getTime() < Date.now() - 86400000) {
      return res.status(400).json({ error: 'Choose a future preferred date.' });
    }
    let assetId = null;
    let selectedAsset = null;
    if (req.body.assetId) {
      if (!validId(req.body.assetId)) return res.status(400).json({ error: 'Invalid aircon asset.' });
      const asset = await CustomerAsset.findOne({ _id: req.body.assetId, customerId: req.user._id, status: { $ne: 'retired' } }).select('_id equipment').lean();
      if (!asset) return res.status(404).json({ error: 'This aircon asset was not found in your account.' });
      assetId = asset._id;
      selectedAsset = asset;
    }
    const rawHp = req.body.unit?.hp || selectedAsset?.equipment?.capacity;
    const hp = rawHp == null || rawHp === '' || !Number.isFinite(Number(rawHp)) ? null : Number(rawHp);
    if (hp !== null && (!Number.isFinite(hp) || hp <= 0 || hp > 20)) return res.status(400).json({ error: 'Enter a valid HP or leave it blank for staff to check.' });
    const request = await RelocationRequest.create({
      customerId: req.user._id, serviceId: service._id, assetId,
      scope: 'custom_quote', from, to, preferredDate,
      unit: {
        brand: clean(req.body.unit?.brand || selectedAsset?.equipment?.brand, 80),
        airconType: clean(req.body.unit?.airconType || selectedAsset?.equipment?.applianceType, 40), hp,
        model: clean(req.body.unit?.model || selectedAsset?.equipment?.model, 80),
        serialNumber: clean(req.body.unit?.serialNumber || selectedAsset?.equipment?.serialNumber, 100),
      },
      notes: clean(req.body.notes, 1000),
      events: [{ action: 'requested', actorId: req.user._id }],
    });
    for (const role of ['admin', 'secretary']) {
      createNotification({ type: 'system', role, title: 'Relocation quote requested',
        message: 'Review both locations and prepare the Aircon Relocation quote.',
        link: `/${role}/relocation-requests`, priority: 'normal', io: req.app.get('io') }).catch(() => {});
    }
    return res.status(201).json({ id: request._id, status: request.status });
  } catch (error) {
    console.error('Relocation request failed:', error);
    return res.status(500).json({ error: 'Could not submit your relocation request. Please try again.' });
  }
});

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

router.post('/mine/:id/decision', customer, async (req, res) => {
  if (!validId(req.params.id) || !['accept', 'decline'].includes(req.body.decision)) return res.status(400).json({ error: 'Invalid decision.' });
  const version = Number(req.body.version);
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'Refresh the quote before deciding.' });
  const status = req.body.decision === 'accept' ? 'accepted' : 'declined';
  const updated = await RelocationRequest.findOneAndUpdate({
    _id: req.params.id, customerId: req.user._id, status: 'quoted', 'quote.version': version,
    'quote.expiresAt': { $gt: new Date() }, bookingId: null,
  }, {
    $set: { status, ...(status === 'accepted' ? { acceptedAt: new Date() } : {}) },
    $push: { events: { action: status, actorId: req.user._id } },
  }, { returnDocument: 'after' });
  if (!updated) return res.status(409).json({ error: 'This quote changed or expired. Refresh the request.' });
  for (const role of ['admin', 'secretary']) {
    createNotification({ type: 'system', role, title: `Relocation quote ${status}`,
      message: `The customer ${status} the relocation quote.`, link: `/${role}/relocation-requests`,
      priority: 'normal', io: req.app.get('io') }).catch(() => {});
  }
  return res.json({ status: updated.status });
});

router.get('/staff', staff, async (req, res) => {
  const requests = await RelocationRequest.find({ status: { $in: ['pending_review', 'assessment_needed', 'quoted', 'accepted', 'converted'] } })
    .populate('customerId', 'firstName lastName email phone mobile')
    .sort({ createdAt: -1 }).limit(100).lean();
  return res.json({ requests });
});

router.post('/staff/:id/assessment', staff, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  const note = clean(req.body.notes, 1000);
  if (note.length < 10) return res.status(400).json({ error: 'Record what must be assessed.' });
  const updated = await RelocationRequest.findOneAndUpdate({ _id: req.params.id, status: { $in: ['pending_review', 'assessment_needed'] } }, {
    $set: { status: 'assessment_needed', assessmentNotes: note },
    $push: { events: { action: 'assessment_needed', actorId: req.user._id, note } },
  }, { returnDocument: 'after' });
  if (!updated) return res.status(409).json({ error: 'This request changed. Refresh the queue.' });
  createNotification({ type: 'system', userId: updated.customerId, title: 'Relocation assessment needed',
    message: 'We need to assess your relocation before sending a quote. Staff will contact you.',
    link: '/relocation-requests', io: req.app.get('io') }).catch(() => {});
  return res.json({ status: updated.status });
});

router.post('/staff/:id/quote', staff, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length || lines.length > 20 || lines.some(line =>
    clean(line?.label, 100).length < 2 || !Number.isFinite(Number(line?.amount)) || Number(line.amount) < 0 || Number(line.amount) > 1000000)) {
    return res.status(400).json({ error: 'Enter valid itemized costs.' });
  }
  const cleanLines = lines.map(line => ({ label: clean(line.label, 100), amount: Math.round(Number(line.amount) * 100) / 100 }));
  const total = Math.round(cleanLines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  if (total <= 0) return res.status(400).json({ error: 'Quote total must be greater than zero.' });
  const expectedVersion = Number(req.body.expectedVersion || 0);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return res.status(400).json({ error: 'Refresh the quote.' });
  const durationMinutes = Number(req.body.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 60 || durationMinutes > 1440) {
    return res.status(400).json({ error: 'Enter an estimated technician time between 1 and 24 hours.' });
  }
  const current = await RelocationRequest.findOne({ _id: req.params.id, status: { $in: ['pending_review', 'assessment_needed', 'quoted', 'accepted'] } }).lean();
  if (!current) return res.status(409).json({ error: 'This request is no longer open.' });
  const renewExpiredAcceptance = current.status === 'accepted' && current.quote?.expiresAt && current.quote.expiresAt <= new Date() && !current.bookingId;
  if (current.status === 'accepted' && !renewExpiredAcceptance) return res.status(409).json({ error: 'The customer already accepted this quote.' });
  const catalog = await CoreService.findOne({ _id: current.serviceId, slug: 'aircon-relocation', active: true }).lean();
  if (!catalog) return res.status(409).json({ error: 'Aircon Relocation is unavailable.' });
  const unit = {
    brand: clean(req.body.brand || current.unit?.brand, 80),
    airconType: clean(req.body.airconType || current.unit?.airconType, 40),
    hp: Number(req.body.hp || current.unit?.hp),
    model: clean(current.unit?.model, 80), serialNumber: clean(current.unit?.serialNumber, 100),
  };
  try { resolveCoreServicePricing(catalog, { ...unit, quantity: 1 }); }
  catch (error) { return res.status(400).json({ error: `Verify the unit type, HP, and brand before quoting: ${error.message}` }); }
  const quote = {
    lines: cleanLines, total, durationMinutes, notes: clean(req.body.notes, 1000), version: expectedVersion + 1,
    quotedAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86400000), quotedBy: req.user._id,
  };
  const updated = await RelocationRequest.findOneAndUpdate({ _id: req.params.id,
    status: current.status, 'quote.version': expectedVersion,
    ...(renewExpiredAcceptance ? { 'quote.expiresAt': { $lte: new Date() } } : {}),
    bookingId: null,
  }, {
    $set: { quote, unit, status: 'quoted', acceptedAt: null },
    $push: { events: { action: 'quoted', actorId: req.user._id, note: `Quote version ${quote.version}` } },
  }, { returnDocument: 'after' });
  if (!updated) return res.status(409).json({ error: 'This quote changed. Refresh the queue.' });
  createNotification({ type: 'system', userId: updated.customerId, title: 'Your relocation quote is ready',
    message: 'Review the itemized Aircon Relocation quote and accept or decline it.',
    link: '/relocation-requests', priority: 'high', io: req.app.get('io') }).catch(() => {});
  return res.json({ status: updated.status, quote: updated.quote });
});

module.exports = router;
