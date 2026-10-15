const express = require('express');
const mongoose = require('mongoose');
const { rateLimit } = require('../utils/boundedRateLimit');
const auth = require('../middleware/authenticate');
const { authenticatedOrIpKey } = require('../utils/rateLimitIdentity');
const CoreService = require('../models/CoreService');
const BookingService = require('../models/BookingService');
const UnitAssistanceRequest = require('../models/UnitAssistanceRequest');
const CustomerAsset = require('../models/CustomerAsset');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');
const { createNotification } = require('../utils/notify');
const { normalizeUnitAssistance } = require('../utils/unitAssistancePolicy');
const unitAssistanceUpload = require('../middleware/unitAssistanceUpload');
const { storePhoto, deletePhoto, downloadPhoto } = require('../utils/unitAssistancePhotos');
const A = require('../public/js/appliance-services');
const repairIdentification = require('../utils/repairIdentificationPolicy');

const router = express.Router();
router.use(auth.authenticate);
const customer = auth.requireRole('customer');
const staff = auth.requireRole(['admin', 'secretary']);
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyGenerator: authenticatedOrIpKey, standardHeaders: true, legacyHeaders: false });
const validId = id => mongoose.isValidObjectId(id);
const customerFields = '_id requestType repair serviceId serviceName existingBookingId existingBookingReference applianceKind model photos brand airconType hp quantity relocation notes status createdAt quote.applianceKind quote.unitType quote.unitCategory quote.brand quote.airconType quote.airconTypeName quote.hp quote.unitPrice quote.durationMinutes quote.notes quote.quotedAt quote.expiresAt';

router.post('/', customer, limiter, unitAssistanceUpload, async (req, res) => {
  const storedPhotos = [];
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Enter your appliance details.' });
    const isRepair = req.body.requestType === 'repair';
    if (req.body.requestType != null && !['core', 'repair'].includes(req.body.requestType)) return res.status(400).json({ error: 'Choose a valid request type.' });
    if (!isRepair && typeof req.body.serviceId !== 'string') return res.status(400).json({ error: 'Choose a valid service.' });
    const serviceId = String(req.body.serviceId || '');
    const quantity = Number(req.body.quantity);
    const clientRequestId = req.body.clientRequestId;
    if (clientRequestId !== undefined && (typeof clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{12,100}$/.test(clientRequestId))) return res.status(400).json({ error:'Invalid request reference. Reopen the service and try again.' });
    if ((!isRepair && !validId(serviceId)) || !Number.isInteger(quantity) || quantity < 1 || quantity > 40) {
      return res.status(400).json({ error: 'Choose a valid service and unit quantity.' });
    }
    if (clientRequestId) {
      const existing = await UnitAssistanceRequest.findOne({ customerId:req.user._id, clientRequestId }).select('_id status').lean();
      if (existing) return res.json({ id:existing._id, status:existing.status });
    }
    const catalog = isRepair ? { name: 'Repair inspection' } : await CoreService.findOne({ _id: serviceId, active: true }).lean();
    if (!catalog) return res.status(400).json({ error: 'This service is unavailable.' });
    const details = isRepair ? await repairIdentification.normalizeRepairIdentification(req.body) : normalizeUnitAssistance(catalog, req.body);
    if (catalog.slug === 'aircon-relocation' && details.applianceKind !== 'aircon') return res.status(400).json({ error: 'Relocation requires an aircon.' });
    let relocation = undefined;
    if (catalog.slug === 'aircon-relocation') {
      const fromPosition = String(req.body.relocation?.fromPosition || '').trim().slice(0, 500);
      const toPosition = String(req.body.relocation?.toPosition || '').trim().slice(0, 500);
      if (quantity !== 1 || req.body.relocation?.scope !== 'same_property' || fromPosition.length < 2 || toPosition.length < 2) {
        return res.status(400).json({ error: 'For same-property relocation, describe both positions for one aircon unit.' });
      }
      let assetId = null;
      if (req.body.relocation?.assetId) {
        if (!validId(req.body.relocation.assetId)) return res.status(400).json({ error: 'Invalid aircon asset.' });
        const asset = await CustomerAsset.findOne({ _id: req.body.relocation.assetId, customerId: req.user._id, status: { $ne: 'retired' } }).select('_id').lean();
        if (!asset) return res.status(404).json({ error: 'Aircon asset not found.' });
        assetId = asset._id;
      }
      relocation = { scope: 'same_property', fromPosition, toPosition, assetId,
        model: String(req.body.relocation.model || '').trim().slice(0, 80),
        serialNumber: String(req.body.relocation.serialNumber || '').trim().slice(0, 100) };
    }
    const { brand, airconType, hp } = details;
    if (!isRepair && details.applianceKind === 'aircon' && brand && brand.toLowerCase() !== "i don't know" && airconType && hp != null) {
      const type = catalog.airconTypes?.find(item => item.type === airconType);
      const tiers = type?.hpPricing || catalog.hpPricing || [];
      if (tiers.some(tier => Number(tier.hp) === hp && Number.isFinite(Number(tier.price)))) {
        return res.status(400).json({ error: 'This HP already has a catalog price. Select it in the regular booking.' });
      }
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
    for (const file of req.files || []) storedPhotos.push(await storePhoto(file, req.user._id));
    const request = await UnitAssistanceRequest.create({
      customerId: req.user._id, serviceId, serviceName: catalog.name,
      ...(clientRequestId ? { clientRequestId } : {}),
      existingBookingId: existingBooking?._id || null,
      existingBookingReference: existingBooking?.bookingReference || '',
      ...details, relocation, photos: storedPhotos,
      events: [{ action: 'requested', actorId: req.user._id, notes: details.notes }],
    });
    for (const role of ['admin', 'secretary']) {
      createNotification({ type: 'system', role, title: 'Unit identification requested',
        message: `${request.serviceName}: customer needs help identifying a ${(A.labels[details.applianceKind] || 'repair appliance').toLowerCase()}${existingBooking ? ` for booking ${existingBooking.bookingReference}` : ' before booking'}.`,
        link: `/${role}/unit-assistance`, priority: 'normal', io: req.app.get('io') }).catch(() => {});
    }
    return res.status(201).json({ id: request._id, status: request.status });
  } catch (error) {
    await Promise.all(storedPhotos.map(photo => deletePhoto(photo.fileId).catch(() => {})));
    if (error.code === 11000 && req.body.clientRequestId) {
      const existing = await UnitAssistanceRequest.findOne({ customerId:req.user._id, clientRequestId:req.body.clientRequestId }).select('_id status').lean();
      if (existing) return res.json({ id:existing._id, status:existing.status });
    }
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('Unit assistance request failed:', error);
    return res.status(500).json({ error: 'Could not submit your request. Please try again.' });
  }
});

router.get('/:id/photos/:index', auth.requireRole(['customer', 'admin', 'secretary']), async (req, res, next) => {
  try {
    if (!validId(req.params.id) || !/^[01]$/.test(req.params.index)) return res.status(404).json({ error: 'Photo not found.' });
    const request = await UnitAssistanceRequest.findOne({ _id: req.params.id, ...(req.user.role === 'customer' ? { customerId: req.user._id } : {}) }).select('photos').lean();
    const photo = request?.photos?.[Number(req.params.index)];
    if (!photo) return res.status(404).json({ error: 'Photo not found.' });
    res.set({ 'Content-Type': photo.contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    const stream = downloadPhoto(photo.fileId);
    stream.once('error', error => { if (res.headersSent) res.destroy(); else next(error); });
    res.once('close', () => stream.destroy()); stream.pipe(res);
  } catch (error) { next(error); }
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
  }, { returnDocument: "after" });
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
    .populate('serviceId', 'name isAirconService basePrice durationMinutes durationRange airconTypes hpPricing applianceProfiles active')
    .sort({ createdAt: -1 }).limit(100).lean();
  return res.json({ requests });
});

router.post('/staff/:id/quote', staff, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Enter the verified unit details.' });
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid request.' });
    const request = await UnitAssistanceRequest.findOne({ _id: req.params.id, status: { $in: ['pending', 'quoted', 'accepted'] } });
    if (!request) return res.status(409).json({ error: 'This request can no longer be quoted. Refresh the queue.' });
    const renewingExpiredAcceptance = request.status === 'accepted'
      && !request.existingBookingId && !request.bookingId
      && request.quote?.expiresAt && request.quote.expiresAt <= new Date();
    if (request.status === 'accepted' && !renewingExpiredAcceptance) {
      return res.status(409).json({ error: 'The customer already accepted this quote. Refresh the queue.' });
    }
    if (request.status !== 'pending' && (!request.quote?.quotedAt || String(req.body.expectedQuotedAt || '') !== request.quote.quotedAt.toISOString())) {
      return res.status(409).json({ error: 'This quote changed while you were editing. Refresh the queue before updating it.' });
    }
    const modelResult = require('../utils/repairModelPolicy').validateRepairModel(Object.hasOwn(req.body, 'model') ? req.body.model : request.model, { required: true });
    if (!modelResult.valid) return res.status(400).json({ error: modelResult.error });
    const isRepair = request.requestType === 'repair';
    const catalog = isRepair ? null : await CoreService.findOne({ _id: request.serviceId, active: true }).lean();
    const verificationMethod = typeof req.body.verificationMethod === 'string' ? req.body.verificationMethod : '';
    if (!['customer_contact', 'model_label', 'site_visit'].includes(verificationMethod)) {
      return res.status(400).json({ error: 'Select how the unit details were verified.' });
    }
    const brandValue = req.body.brand || request.brand || '';
    if (typeof brandValue !== 'string' || brandValue.length > 80 || req.body.notes != null && (typeof req.body.notes !== 'string' || req.body.notes.length > 1000) ||
        req.body.hp != null && !['string', 'number'].includes(typeof req.body.hp) || req.body.airconType != null && typeof req.body.airconType !== 'string') {
      return res.status(400).json({ error: 'Check the verified brand, type, HP and notes.' });
    }
    const brand = brandValue.trim();
    if (repairIdentification.unknownBrand(brand)) return res.status(400).json({ error: 'Confirm the appliance brand before sending a quote.' });
    const selection = { brand, airconType: req.body.airconType, hp: req.body.hp, quantity: request.quantity, ...(request.applianceKind ? { applianceKind: request.applianceKind } : {}) };
    const pricing = isRepair ? await repairIdentification.verifiedRepairPricing(request, { ...req.body, brand }) : resolveCoreServicePricing(catalog, selection);
    const quote = {
      applianceKind: request.applianceKind || 'aircon',
      brand, airconType: pricing.airconType, airconTypeName: pricing.airconTypeName,
      hp: pricing.hp, unitPrice: pricing.unitPrice, durationMinutes: pricing.duration,
      ...(isRepair ? { unitType: pricing.unitType, unitCategory: pricing.unitCategory } : {}),
      notes: String(req.body.notes || '').trim().slice(0, 1000),
      verificationMethod,
      quotedBy: req.user._id, quotedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
    const updated = await UnitAssistanceRequest.findOneAndUpdate({
      _id: request._id, status: request.status, bookingId: null,
      ...(request.status !== 'pending' ? { 'quote.quotedAt': request.quote.quotedAt } : {}),
      ...(renewingExpiredAcceptance ? { existingBookingId: null, 'quote.expiresAt': { $lte: new Date() } } : {}),
    },
      { $set: { quote, model: modelResult.value, status: 'quoted', acceptedAt: null },
        $push: { events: { action: 'quoted', actorId: req.user._id, unitPrice: pricing.unitPrice, notes: quote.notes } } }, { returnDocument: "after" });
    if (!updated) return res.status(409).json({ error: 'This request was updated. Reload the queue.' });
    createNotification({ type: 'system', userId: updated.customerId,
      title: isRepair ? 'Your verified repair unit and inspection fee are ready' : 'Your appliance service quote is ready',
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
    $push: { events: { action: 'resolved', actorId: req.user._id, notes } } }, { returnDocument: "after" });
  if (!updated) return res.status(409).json({ error: 'This request is no longer awaiting resolution.' });
  createNotification({ type: 'system', userId: updated.customerId,
    title: 'Your unit request was handled', message: `Staff updated the request for ${updated.existingBookingReference}. Review your booking history.`,
    link: '/book-history', priority: 'normal', io: req.app.get('io') }).catch(() => {});
  return res.json({ status: updated.status });
});

module.exports = router;
