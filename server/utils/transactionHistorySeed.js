'use strict';

const crypto = require('node:crypto'), mongoose = require('mongoose');
const dates = require('./reportingDates'), recovery = require('./resetRecoveryBackup');
const { NOTICE } = require('./demonstrationData');
const { auditModelSchemas } = require('./modelSchemaAudit');
const { bookingReportValue } = require('./bookingReportValue');
const OPERATION = 'transaction-history-seed-v1';
const DEFAULTS = Object.freeze({ batch: 'history-demo-2022-2026-v1', count: 1000, from: '2022-01-01', to: '2026-10-15' });
const COLLECTIONS = Object.freeze({ bookingservices: 'BookingService', orders: 'Order', assignments: 'Assignment', payments: 'Payment', servicereports: 'ServiceReport' });
const reasons = Object.freeze([
  'Customer requested cancellation because their plans changed.',
  'Duplicate request; the customer retained their other booking or order.',
  'Customer could not provide access to the service or delivery location.',
  'Customer could not proceed on the agreed date and chose to cancel.',
  'Customer changed their appliance requirements before work or delivery began.',
]);
const money = amount => Math.round(Number(amount) * 100) / 100;
const id = value => String(value?._id || value || '');
const seedId = (batch, key) => new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`${OPERATION}:${batch}:${key}`).digest('hex').slice(0, 24));
const markerId = config => seedId(config.batch, 'manifest');
function configuration(input = {}, now = new Date()) {
  const config = { ...DEFAULTS, ...input };
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(config.batch)) throw Error('Batch must contain 3–80 lowercase letters, digits or hyphens.');
  if (!Number.isInteger(config.count) || config.count < 10 || config.count > 1000 || config.count % 10) throw Error('Count must be a multiple of 10 from 10 to 1000.');
  const from = dates.parseDate(config.from), to = dates.parseDate(config.to);
  if (!Number.isFinite(from?.getTime()) || !Number.isFinite(to?.getTime()) || from >= to || to >= dates.startOfDay(now) || to - from < 7 * dates.DAY) throw Error('Choose historical Manila dates spanning at least seven days, ending before today.');
  return config;
}
function eligibleCustomer(user) {
  return user.role === 'customer' && user.active !== false && !user.blocked && !user.archivedAt && user.accountStatus !== 'invited'
    && user.emailVerified === true && /^[a-z0-9._%+-]+@gmail\.com$/i.test(user.email || '')
    && (Number.isFinite(new Date(user.emailVerifiedAt || NaN).getTime()) || user.hasGoogleIdentity === true);
}
function eligibleTechnicians(snapshot) {
  const users = new Map(snapshot.staffUsers.map(user => [id(user), user]));
  return snapshot.technicians.filter(tech => {
    const account = users.get(id(tech.user));
    return tech.active !== false && !tech.archivedAt && account?.role === 'technician' && account.active !== false && !account.blocked && !account.archivedAt;
  });
}
function productChoices(snapshot) {
  const brands = new Map(snapshot.brands.map(brand => [id(brand), brand.name]));
  const normalize = (row, parent) => ({ inventoryId: row._id, parentHvacId: parent?._id || null, isHvac: Boolean(parent),
    modelLine: parent?.modelLine || row.modelLine, brand: brands.get(id(parent?.brand || row.brand)) || 'Aircon',
    capacity: String(row.capacity || '1'), capacityUnit: row.capacityUnit || 'HP', unitPrice: money(row.sellingPrice), costPrice: money(row.costPrice) });
  const products = snapshot.inventory.filter(row => row.active !== false && row.status !== 'discontinued').map(row => normalize(row));
  for (const parent of snapshot.hvac.filter(row => row.active !== false && row.status !== 'discontinued')) {
    for (const variant of parent.variants || []) if (variant.active !== false && variant.status !== 'discontinued') products.push(normalize(variant, parent));
  }
  return products.filter(row => row.modelLine && Number.isFinite(row.unitPrice) && row.unitPrice > 0 && Number.isFinite(row.costPrice) && row.costPrice > 0);
}
function serviceChoices(snapshot) {
  const choices = [];
  for (const service of snapshot.services.filter(row => row.active !== false && !row.archivedAt && !/relocat/i.test(row.slug || row.name || ''))) {
    if (!service.isAirconService && !service.airconTypes?.length && !service.hpPricing?.length) continue;
    const types = service.airconTypes?.length ? service.airconTypes : [{ type: 'split', name: 'Split Type', hpPricing: service.hpPricing || [] }];
    for (const type of types) {
      const tiers = type.hpPricing?.length ? type.hpPricing : [{ hp: 1, price: service.basePrice }];
      for (const tier of tiers) {
        const duration = Number(tier.durationMinutes || service.durationMinutes || 60);
        if (Number(tier.price) > 0 && Number.isInteger(duration) && duration > 0 && duration <= 360) choices.push({ service,
          airconType: type.type, airconTypeName: type.name || type.type, hp: Number(tier.hp) || 1, price: money(tier.price), duration });
      }
    }
  }
  return choices;
}
function repairChoices(snapshot) {
  const setting = snapshot.settings.find(row => row.key === 'repairInspectionDefaultFee');
  const defaultFee = Number(setting?.value ?? 500);
  return snapshot.categories.filter(row => row.active !== false && !row.archivedAt && !row.isCustom && row.slug !== 'other')
    .flatMap(category => (category.unitTypes || []).filter(unit => !/^other$/i.test(unit.value)).map(unit => ({
      category: category.slug, unitType: unit.value, label: unit.label, price: money(unit.inspectionFee ?? defaultFee),
    }))).filter(row => Number.isFinite(row.price) && row.price > 0);
}
function prerequisites(snapshot) {
  const issues = [];
  if (!snapshot.users.some(eligibleCustomer)) issues.push('No active customer with a verified Gmail address and email-verification or Google identity evidence.');
  if (!eligibleTechnicians(snapshot).length) issues.push('No active technician linked to an active technician account.');
  if (!serviceChoices(snapshot).length) issues.push('No eligible priced core service with a standard-appointment duration.');
  if (!repairChoices(snapshot).length) issues.push('No active supported repair appliance with an inspection fee.');
  if (!productChoices(snapshot).length) issues.push('No active aircon product with both a positive buying price and selling price.');
  return issues;
}
async function readDependencies(db, session) {
  const read = async (collection, filter, projection) => {
    const rows = await db.collection(collection).find(filter, { session, projection }).sort({ _id: 1 }).limit(10001).maxTimeMS(15000).toArray();
    if (rows.length > 10000) throw Error('Seed source limit exceeded; narrow the customer/catalog scope before proceeding.');
    return rows;
  };
  const snapshot = {};
  // The transaction caller requires sequential database operations.
  snapshot.users = await db.collection('users').aggregate([
    { $match: { role: 'customer', email: /@gmail\.com$/i, emailVerified: true, active: { $ne: false }, blocked: { $ne: true }, archivedAt: null, accountStatus: { $ne: 'invited' } } },
    { $project: { firstName: 1, lastName: 1, email: 1, phone: 1, address: 1, role: 1, active: 1, blocked: 1, archivedAt: 1, accountStatus: 1, emailVerified: 1, emailVerifiedAt: 1,
      hasGoogleIdentity: { $cond: [{ $eq: [{ $type: '$googleSubject' }, 'string'] }, { $ne: ['$googleSubject', ''] }, false] } } },
    { $sort: { _id: 1 } }, { $limit: 10001 },
  ], { session, maxTimeMS: 15000 }).toArray();
  if (snapshot.users.length > 10000) throw Error('Customer source limit exceeded.');
  snapshot.users = snapshot.users.filter(eligibleCustomer);
  snapshot.technicians = await read('technicians', { active: { $ne: false }, archivedAt: null }, { name: 1, user: 1, userEmail: 1, phone: 1, active: 1, archivedAt: 1 });
  snapshot.staffUsers = await read('users', { _id: { $in: snapshot.technicians.map(tech => tech.user).filter(Boolean) } }, { role: 1, active: 1, blocked: 1, archivedAt: 1 });
  snapshot.services = await read('coreservices', { active: { $ne: false }, archivedAt: null }, { name: 1, slug: 1, active: 1, archivedAt: 1, basePrice: 1, isAirconService: 1, hpPricing: 1, airconTypes: 1, durationMinutes: 1, brands: 1 });
  snapshot.categories = await read('servicecategories', { active: { $ne: false }, archivedAt: null }, { name: 1, slug: 1, active: 1, archivedAt: 1, isCustom: 1, unitTypes: 1 });
  snapshot.inventory = await read('inventories', { active: { $ne: false } }, { modelLine: 1, brand: 1, capacity: 1, capacityUnit: 1, sellingPrice: 1, costPrice: 1, active: 1, status: 1 });
  snapshot.hvac = await read(require('../models/HVACProduct').collection.name, { active: { $ne: false } }, { modelLine: 1, brand: 1, active: 1, status: 1, 'variants._id': 1, 'variants.capacity': 1, 'variants.capacityUnit': 1, 'variants.sellingPrice': 1, 'variants.costPrice': 1, 'variants.active': 1, 'variants.status': 1 });
  snapshot.brands = await read('brands', {}, { name: 1 });
  snapshot.settings = await read('sitesettings', { key: 'repairInspectionDefaultFee' }, { key: 1, value: 1 });
  return snapshot;
}

async function buildSeed(snapshot, config, generatedAt = new Date()) {
  const issues = prerequisites(snapshot); if (issues.length) throw Error(issues.join(' '));
  const customers = snapshot.users.filter(eligibleCustomer), technicians = eligibleTechnicians(snapshot);
  const core = serviceChoices(snapshot), repairs = repairChoices(snapshot), products = productChoices(snapshot);
  const seed = Object.fromEntries(Object.keys(COLLECTIONS).map(name => [name, []]));
  const demonstration = { batch: config.batch, generatedAt, notice: NOTICE, notificationsSuppressed: true, physicalStockMoved: false, moneyReceived: false };
  const objectId = key => seedId(config.batch, key), perChannel = config.count / 2;
  const first = dates.parseDate(config.from).getTime() + 3 * dates.DAY, last = dates.parseDate(config.to).getTime();
  const referenceTag = crypto.createHash('sha256').update(config.batch).digest('hex').slice(0, 6).toUpperCase();
  const businessDay = index => new Date(first + Math.floor(index / Math.max(1, perChannel - 1) * ((last - first) / dates.DAY)) * dates.DAY);
  const at = (day, hour) => new Date(day.getTime() + hour * 3600000);
  const customerSnapshot = user => ({ _id: user._id, name: [user.firstName, user.lastName].filter(Boolean).join(' '), email: user.email, phone: user.phone,
    address: ['Demonstration site', user.address?.barangay, user.address?.city, 'Nueva Ecija'].filter(Boolean).join(', ') });
  const technicianSnapshot = tech => ({ _id: tech._id, name: tech.name, email: tech.userEmail, phone: tech.phone });
  async function add(collection, row) {
    const Model = require('../models/' + COLLECTIONS[collection]);
    const document = new Model({ ...row, demonstration }, undefined, { strict: 'throw' });
    await document.validate();
    const saved = document.toObject({ virtuals: false, versionKey: false, transform: false });
    seed[collection].push(saved); return saved;
  }
  const note = key => ({ _id: objectId(key), text: NOTICE, byName: 'Demonstration seed', createdAt: generatedAt });
  async function payment(parent, amount, key, when, type = 'final') {
    return add('payments', { _id: objectId(key), ...parent, amount, method: 'cash', gateway: 'cod', type, status: 'paid',
      reference: `DEMO-${referenceTag}-${key}`, notes: NOTICE, submittedAt: when, collectedAt: when, remittedAt: when, verifiedAt: when, completedAt: when,
      events: [{ _id: objectId(key + '-event'), status: 'paid', actorName: 'Demonstration seed', actorRole: 'System', note: NOTICE, at: when }] });
  }
  for (let index = 0; index < perChannel; index++) {
    const user = customers[index % customers.length], tech = technicians[index % technicians.length], day = businessDay(index);
    const completed = index % 5 !== 4, repair = index % 4 === 0, choice = core[index % core.length], inspection = repairs[index % repairs.length];
    const quantity = repair ? 1 : 1 + index % Math.min(3, Math.floor(360 / choice.duration));
    const unitPrice = repair ? inspection.price : choice.price, inspectionTotal = repair ? unitPrice * quantity : 0;
    const quotation = repair && completed ? money(inspectionTotal * 1.5) : 0;
    const workMinutes = repair ? completed ? 240 : 90 : choice.duration * quantity;
    const endMinutes = 9 * 60 + workMinutes;
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
    const amount = money(unitPrice * quantity + quotation), started = at(day, 9), finished = at(day, 9 + workMinutes / 60);
    const created = new Date(day.getTime() - 3 * dates.DAY + 8 * 3600000), cancelled = new Date(day.getTime() - dates.DAY + 10 * 3600000);
    const bookingId = objectId(`service-${index}`), itemId = objectId(`service-${index}-item`), assignmentId = objectId(`service-${index}-assignment`);
    const type = repair ? 'repair' : 'core', name = repair ? `Repair inspection · ${inspection.label}` : choice.service.name;
    const brand = choice.service.brands?.find(value => value && !/unknown|don't know|other/i.test(value)) || products[index % products.length].brand;
    const cancellationReason = completed ? '' : `DEMO scenario: ${reasons[Math.floor(index / 5) % reasons.length]}`;
    const history = (status, time, sequence) => ({ _id: objectId(`service-${index}-history-${sequence}`), toStatus: status, changedByModel: 'System', changedByName: 'Demonstration seed', reason: NOTICE, timestamp: time });
    const row = {
      _id: bookingId, bookingReference: `DEMO-SVC-${dates.dateKey(day).replaceAll('-', '')}-${referenceTag}-${String(index + 1).padStart(4, '0')}`,
      customerId: user._id, customer: customerSnapshot(user), technicianId: completed ? tech._id : null,
      ...(completed ? { technician: technicianSnapshot(tech), assignmentId, assignedAt: new Date(started.getTime() - dates.DAY) } : {}),
      serviceType: type, serviceModel: repair ? 'RepairService' : 'CoreService', ...(!repair ? { serviceId: choice.service._id } : {}),
      service: { ...(!repair ? { _id: choice.service._id } : {}), name }, servicePrice: unitPrice, quantity,
      isMultiService: true, isProject: false, serviceDurationMinutes: workMinutes,
      brand, applianceType: repair ? inspection.unitType : choice.airconType, applianceTypeName: repair ? inspection.label : choice.airconTypeName, hp: repair ? undefined : choice.hp,
      unitInfo: { brand, model: 'DEMO-APPLIANCE-' + String(index + 1).padStart(4, '0'), unitType: repair ? inspection.unitType : choice.airconTypeName },
      services: [{ _id: itemId, serviceId: repair ? null : choice.service._id, applianceGroupId: repair ? undefined : `demo-unit-${index}`, applianceKind: repair ? undefined : 'aircon', name, type,
        brand, model: 'DEMO-APPLIANCE-' + String(index + 1).padStart(4, '0'), quantity, unitPrice, totalPrice: money(unitPrice * quantity), duration: repair ? 90 : choice.duration,
        hp: repair ? undefined : choice.hp, airconType: repair ? '' : choice.airconType, airconTypeName: repair ? '' : choice.airconTypeName,
        ...(repair ? { unitCategory: inspection.category, unitType: inspection.unitType, applianceType: inspection.unitType, applianceTypeName: inspection.label, initialCost: inspection.price,
          problemDescription: 'DEMO scenario: appliance needs inspection and adjustment; no replacement parts are required.',
          ...(completed ? { quotation: { laborCost: quotation, totalCost: quotation, status: 'approved', createdAt: at(day, 10) }, approval: { status: 'approved', decidedAt: at(day, 11) } } : {}) } : {}),
        status: completed ? 'completed' : 'cancelled', phase: repair ? completed ? 'repair_phase_2' : 'repair_phase_1' : 'core', technicianId: completed ? tech._id : null, assignmentId: completed ? assignmentId : null,
        schedule: { date: day, startTime: '09:00', endTime, durationMinutes: workMinutes, kind: repair ? completed ? 'repair' : 'inspection' : 'service' },
        units: Array.from({ length: quantity }, (_, unitIndex) => ({ _id: objectId(`service-${index}-unit-${unitIndex}`), unitIndex: unitIndex + 1,
          label: `Demo unit ${unitIndex + 1}`, status: completed ? 'completed' : 'skipped', ...(completed ? { completedAt: finished, completedBy: tech._id, completionNotes: NOTICE } : {}) })),
      }],
      bookingDate: day, startTime: '09:00', endTime, selectedTimeLabel: `09:00 – ${endTime}`, status: completed ? 'completed' : 'cancelled',
      totalPrice: amount, estimatedFee: amount, totalInitialCost: money(unitPrice * quantity), totalFinalCost: repair ? quotation : amount, travelFare: 0,
      paymentMethod: 'other', paymentChannel: 'other', paymentStatus: completed ? 'paid' : 'pending', amountPaid: completed ? amount : 0, balanceAmount: 0,
      balanceCollected: completed, ...(completed ? { balanceCollectedAt: finished, balanceCollectedBy: tech._id, completedAt: finished } : { cancelledAt: cancelled, cancellationReason }),
      refundStatus: 'none', refundAmount: 0, notes: NOTICE, paymentNotes: NOTICE,
      statusHistory: [history(repair ? 'pending_inspection' : 'pending', created, 0), ...(completed ? [history('confirmed', new Date(started.getTime() - dates.DAY), 1), history(repair ? 'repair_in_progress' : 'in-progress', started, 2), history('completed', finished, 3)] : [{ ...history('cancelled', cancelled, 1), reason: cancellationReason }])],
      ...(repair && completed ? { initialCost: inspectionTotal, finalCost: quotation, inspectionFeeCollected: true, inspectionFeeAmount: inspectionTotal, inspectionFeeTotalCollected: inspectionTotal,
        inspectionFeeCollectedAt: at(day, 10), inspectionFeeMethod: 'cash', inspection: { completedAt: at(day, 10), technicianId: tech._id, findings: NOTICE, severity: 'minor' },
        diagnosis: { completedAt: at(day, 10), technicianId: tech._id, findings: NOTICE, replacementPartsRequired: false, laborCost: quotation },
        quotation: { parts: [], laborCost: quotation, totalCost: quotation, notes: NOTICE, createdAt: at(day, 10) }, approval: { status: 'approved', decidedAt: at(day, 11), reason: NOTICE },
        repairPaymentCollected: true, repairPaymentAmount: quotation, repairPaymentMethod: 'cash', repairPaymentCollectedAt: finished,
        repairCompletion: { completedAt: finished, completionNotes: NOTICE, actionsPerformed: ['Demonstration adjustment and operational check'], partsInstalled: [] } } : {}),
      createdAt: created, updatedAt: completed ? finished : cancelled,
    };
    await add('bookingservices', row);
    if (!completed) continue;
    await add('assignments', { _id: assignmentId, bookingId, serviceItemId: itemId, technicianId: tech._id, customerName: row.customer.name, customerEmail: user.email, customerPhone: user.phone,
      serviceType: type, serviceName: name, servicePrice: unitPrice, quantity, estimatedFee: amount, bookingDate: day, startTime: '09:00', endTime, address: row.customer.address,
      status: 'completed', assignedAt: new Date(started.getTime() - dates.DAY), acceptedAt: new Date(started.getTime() - 12 * 3600000), enRouteAt: at(day, 8), arrivedAt: started,
      startedAt: started, completedAt: finished, notes: [note(`service-${index}-assignment-note`)], createdAt: created, updatedAt: finished });
    if (repair) await payment({ bookingId }, inspectionTotal, `service-${index}-inspection-payment`, at(day, 10), 'inspection');
    await payment({ bookingId }, repair ? quotation : amount, `service-${index}-payment`, finished);
    await add('servicereports', { _id: objectId(`service-${index}-report`), bookingId, serviceItemId: itemId, assignmentId, technicianId: tech._id,
      customerName: row.customer.name, serviceName: name, serviceType: type, bookingDate: day, status: 'approved', findings: NOTICE, actionsTaken: NOTICE,
      actualLaborCost: money(amount * 0.25), laborHours: (repair ? 240 : choice.duration * quantity) / 60, submittedAt: finished, approvedAt: finished, createdAt: finished, updatedAt: finished });
  }
  for (let index = 0; index < perChannel; index++) {
    const user = customers[index % customers.length], tech = technicians[index % technicians.length], product = products[index % products.length], day = businessDay(index);
    const completed = index % 5 !== 4, quantity = 1 + index % 3, amount = money(product.unitPrice * quantity);
    const fulfillmentType = ['customer_pickup', 'delivery_only', 'delivery_installation'][index % 3];
    const finished = at(day, fulfillmentType === 'delivery_installation' ? 13 + quantity : 15);
    const created = new Date(day.getTime() - 3 * dates.DAY + 8 * 3600000), cancelled = new Date(day.getTime() - dates.DAY + 10 * 3600000);
    const orderId = objectId(`order-${index}`);
    const installationId = fulfillmentType === 'delivery_installation' ? objectId(`order-${index}-installation`) : null;
    const cancellationReason = completed ? '' : `DEMO scenario: ${reasons[Math.floor(index / 5) % reasons.length]}`;
    const reference = `DEMO-ORD-${dates.dateKey(day).replaceAll('-', '')}-${referenceTag}-${String(index + 1).padStart(4, '0')}`;
    const customer = customerSnapshot(user);
    await add('orders', { _id: orderId, userId: user._id, customer: { name: customer.name, email: user.email, phone: user.phone },
      items: [{ ...product, quantity, totalPrice: amount, serialNumbers: [] }], fulfillmentType, bookingId: installationId, isProject: false,
      ...(fulfillmentType === 'customer_pickup' ? { pickupDate: day } : { delivery: { address: customer.address, contactNumber: user.phone, preferredDate: day, notes: NOTICE } }),
      ...(completed && fulfillmentType !== 'customer_pickup' ? { technicianId: tech._id, technician: technicianSnapshot(tech), technicianAcceptance: { status: 'accepted', respondedAt: at(day, 8) } } : {}),
      status: completed ? 'completed' : 'cancelled', orderReference: reference, subtotal: amount, total: amount, discount: 0, transportationFee: 0, deliveryFee: 0, installationFee: 0,
      paymentMethod: 'cash', paymentStatus: completed ? 'paid' : 'pending', paymentId: completed ? objectId(`order-${index}-payment`) : null,
      downpaymentAmount: completed ? amount : 0, balanceAmount: 0, refundStatus: 'none', refundAmount: 0, salesChannel: 'admin',
      preparation: { dispatch: { status: completed ? 'ready' : 'not_required', note: NOTICE }, installation: { status: installationId ? completed ? 'completed' : 'cancelled' : 'not_required', requiredItems: [], blockers: [] } },
      ...(completed ? { completedAt: finished } : { cancellationReason }),
      statusHistory: [{ status: 'pending_payment', timestamp: created, note: NOTICE }, ...(completed ? [{ status: 'preparing_unit', timestamp: at(day, 8), note: NOTICE }, { status: 'completed', timestamp: finished, note: NOTICE }] : [{ status: 'cancelled', timestamp: cancelled, note: cancellationReason }])],
      createdAt: created, updatedAt: completed ? finished : cancelled,
    });
    if (installationId) await add('bookingservices', { _id: installationId, sourceOrderId: orderId, customerId: user._id, customer,
      bookingReference: reference.replace('DEMO-ORD-', 'DEMO-INST-'), serviceType: 'core', serviceModel: 'CoreService', service: { name: 'Aircon installation included in demonstration order' },
      brand: product.brand, unitInfo: { brand: product.brand, model: String(product.modelLine).slice(0, 50), unitType: 'Aircon' },
      services: [{ _id: objectId(`order-${index}-installation-item`), name: 'Aircon installation included in demonstration order', type: 'core', applianceKind: 'aircon',
        brand: product.brand, model: String(product.modelLine).slice(0, 50), quantity, unitPrice: 0, totalPrice: 0, status: completed ? 'completed' : 'cancelled', phase: 'core',
        duration: 60, schedule: { date: day, startTime: '13:00', endTime: `${13 + quantity}:00`, durationMinutes: 60 * quantity, kind: 'service' },
        units: Array.from({ length: quantity }, (_, unitIndex) => ({ _id: objectId(`order-${index}-unit-${unitIndex}`), unitIndex: unitIndex + 1, label: `Demo installation unit ${unitIndex + 1}`,
          status: completed ? 'completed' : 'skipped', ...(completed ? { completedAt: finished, completedBy: tech._id, completionNotes: NOTICE } : {}) })),
      }], isMultiService: true,
      bookingDate: day, startTime: '13:00', endTime: `${13 + quantity}:00`, serviceDurationMinutes: 60 * quantity, quantity, status: completed ? 'completed' : 'cancelled', isProject: false,
      ...(completed ? { technicianId: tech._id, technician: technicianSnapshot(tech), completedAt: finished } : { cancelledAt: cancelled, cancellationReason }),
      totalPrice: 0, estimatedFee: 0, amountPaid: 0, balanceAmount: 0, paymentStatus: completed ? 'paid' : 'pending', paymentMethod: 'other', paymentChannel: 'other', notes: NOTICE, paymentNotes: NOTICE,
      createdAt: created, updatedAt: completed ? finished : cancelled });
    if (completed) await payment({ orderId }, amount, `order-${index}-payment`, finished);
  }
  assertSeedIntegrity(seed, config);
  assertAccountLinks(seed, snapshot);
  return seed;
}

function assertAccountLinks(seed, snapshot) {
  const users = new Map(snapshot.users.filter(eligibleCustomer).map(user => [id(user), user]));
  const technicians = new Set(eligibleTechnicians(snapshot).map(id));
  for (const row of [...seed.bookingservices, ...seed.orders]) {
    const customer = users.get(id(row.customerId || row.userId));
    if (!customer || row.customer?.email !== customer.email || (row.customerId && id(row.customer?._id) !== id(customer))) throw Error('Seed customer reference or Gmail snapshot does not match an eligible existing account.');
    if (row.technicianId && !technicians.has(id(row.technicianId))) throw Error('Seed references an ineligible technician.');
  }
  for (const assignment of seed.assignments) {
    const parent = seed.bookingservices.find(booking => id(booking._id) === id(assignment.bookingId));
    if (!parent || assignment.customerEmail !== parent.customer.email || !technicians.has(id(assignment.technicianId))) throw Error('Assignment customer or technician snapshot does not match its parent.');
  }
}

function assertSeedIntegrity(seed, config) {
  const bookings = seed.bookingservices.filter(row => !row.sourceOrderId), installations = seed.bookingservices.filter(row => row.sourceOrderId);
  if (bookings.length !== config.count / 2 || seed.orders.length !== config.count / 2) throw Error('Primary transaction counts do not match the seed configuration.');
  for (const rows of [bookings, seed.orders]) if (rows.filter(row => row.status === 'completed').length !== config.count * 0.4) throw Error('Expected 80% completed and 20% cancelled in each channel.');
  const all = Object.values(seed).flat(), unique = new Set(all.map(id));
  if (unique.size !== all.length || all.some(row => row.demonstration?.batch !== config.batch)) throw Error('Duplicate seed IDs or a missing demonstration marker.');
  const balances = new Map();
  for (const row of seed.payments) {
    if (row.status !== 'paid' || !(row.amount > 0) || Boolean(row.bookingId) === Boolean(row.orderId)) throw Error('Invalid demonstration payment.');
    const parent = id(row.bookingId || row.orderId); balances.set(parent, money((balances.get(parent) || 0) + row.amount));
  }
  for (const row of [...bookings, ...seed.orders]) {
    const amount = row.bookingReference ? bookingReportValue(row) : row.total;
    if (!['completed', 'cancelled'].includes(row.status)) throw Error('Seed contains unfinished work.');
    if (row.status === 'completed' && (!row.completedAt || row.paymentStatus !== 'paid' || money(balances.get(id(row)) || 0) !== money(amount) || row.balanceAmount !== 0)) throw Error('Completed work does not reconcile with its payment ledger.');
    if (row.status === 'cancelled' && (!row.cancellationReason || balances.has(id(row)) || row.completedAt)) throw Error('Cancelled work requires a reason and must not have a fabricated payment or completion.');
  }
  for (const row of installations) {
    const parent = seed.orders.find(order => id(order._id) === id(row.sourceOrderId));
    if (!parent || id(parent.bookingId) !== id(row._id) || parent.status !== row.status || bookingReportValue(row) !== 0) throw Error('Installation mirror is orphaned or would double-count order sales.');
  }
  for (const row of seed.assignments) if (!bookings.some(booking => id(booking._id) === id(row.bookingId) && id(booking.assignmentId) === id(row._id) && booking.status === 'completed')) throw Error('Assignment does not match its completed booking.');
  for (const row of seed.servicereports) {
    const booking = bookings.find(parent => id(parent._id) === id(row.bookingId));
    if (!booking || booking.status !== 'completed' || id(row.assignmentId) !== id(booking.assignmentId) || id(row.technicianId) !== id(booking.technicianId)) throw Error('Service report does not match its completed work.');
  }
  for (const booking of bookings.filter(row => row.status === 'completed')) if (!seed.assignments.some(row => id(row._id) === id(booking.assignmentId)) || !seed.servicereports.some(row => id(row.bookingId) === id(booking._id))) throw Error('Completed service is missing its assignment or report.');
  if (seed.payments.some(row => ![...bookings, ...seed.orders].some(parent => id(parent._id) === id(row.bookingId || row.orderId)))) throw Error('Seed contains an orphan payment.');
}

function summary(seed, config) {
  const services = seed.bookingservices.filter(row => !row.sourceOrderId), primary = [...services, ...seed.orders];
  return { configuration: config, primaryTransactions: primary.length,
    services: { completed: services.filter(row => row.status === 'completed').length, cancelled: services.filter(row => row.status === 'cancelled').length, repair: services.filter(row => row.serviceType === 'repair').length },
    orders: { completed: seed.orders.filter(row => row.status === 'completed').length, cancelled: seed.orders.filter(row => row.status === 'cancelled').length },
    linkedRecords: Object.fromEntries(Object.entries(seed).map(([key, rows]) => [key, rows.length])),
    years: Object.fromEntries([2022, 2023, 2024, 2025, 2026].map(year => [year, primary.filter(row => dates.dateKey(row.bookingDate || row.delivery?.preferredDate || row.pickupDate).startsWith(String(year))).length])),
    simulatedSales: money(services.filter(row => row.status === 'completed').reduce((sum, row) => sum + bookingReportValue(row), 0) + seed.orders.filter(row => row.status === 'completed').reduce((sum, row) => sum + row.total, 0)),
    simulatedPayments: money(seed.payments.reduce((sum, row) => sum + row.amount, 0)),
    customerAccounts: new Set(primary.map(row => id(row.customerId || row.userId))).size, customerNotifications: 0, emails: 0, physicalStockChanges: 0, existingRecordsChanged: 0,
    notice: NOTICE, reports: 'This batch is included in reports as clearly labeled demonstration history. Linked installation bookings are not counted as another sale.' };
}

async function previewSeed({ db, config = DEFAULTS, now = new Date(), prepare = false, directory }) {
  config = configuration(config, now);
  const existing = await db.collection('sitesettings').findOne({ _id: markerId(config) });
  if (existing) return { mode: 'already-applied', batch: config.batch, databaseChanges: 0, message: 'This seed batch already exists. No additional records were created.' };
  const audit = auditModelSchemas(), original = await readDependencies(db);
  const blockers = prerequisites(original);
  const schemaAudit = { files: audit.filesScanned, models: audit.modelsScanned, fields: audit.fieldsScanned, fingerprint: audit.fingerprint };
  if (blockers.length) return { mode: 'blocked', configuration: config, schemaAudit, blockers, databaseChanges: 0 };
  const seed = await buildSeed(original, config, now), plan = summary(seed, config);
  const result = { mode: prepare ? 'prepared' : 'dry-run', ...plan, schemaAudit, databaseChanges: 0 };
  if (!prepare) return result;
  const artifact = { operation: OPERATION, database: db.databaseName, preparedAt: now, config, schemaFingerprint: audit.fingerprint,
    sourceFingerprint: recovery.digest(original), seedFingerprint: recovery.digest(seed), original, seed };
  return { ...result, ...await recovery.writeResetBackup(artifact, directory, { namePrefix: 'transaction-history-seed' }),
    next: 'Download both private recovery files before applying. This preparation only writes files; it does not insert transactions.' };
}

async function applySeed({ db, client, backupFile, now = new Date(), verifyOnly = false }) {
  const { artifact: rawArtifact } = await recovery.readResetBackup(backupFile);
  // Recovery files preserve BSON numeric types; application validators and
  // reconciliation use ordinary JavaScript numbers, ObjectIds and Dates.
  const artifact = mongoose.mongo.BSON.EJSON.parse(recovery.serialize(rawArtifact), { relaxed: true });
  if (artifact.operation !== OPERATION || artifact.database !== db.databaseName) throw Error('Prepared seed belongs to a different operation or database.');
  const config = configuration(artifact.config, now), audit = auditModelSchemas();
  if (artifact.schemaFingerprint !== audit.fingerprint) throw Error('Models changed after preparation. Prepare a fresh seed against the current schemas.');
  if (recovery.digest(artifact.seed) !== artifact.seedFingerprint) throw Error('Prepared seed fingerprint does not match.');
  assertSeedIntegrity(artifact.seed, config);
  if (!verifyOnly && now.getTime() - new Date(artifact.preparedAt).getTime() > 86400000) throw Error('Seed preparation expired. Prepare a fresh file.');
  async function verify(session) {
    const actual = {};
    for (const collection of Object.keys(COLLECTIONS)) {
      actual[collection] = await db.collection(collection).find({ 'demonstration.batch': config.batch }, { session }).sort({ _id: 1 }).toArray();
      const expected = [...artifact.seed[collection]].sort((a, b) => id(a).localeCompare(id(b)));
      if (recovery.digest({ rows: actual[collection] }) !== recovery.digest({ rows: expected })) throw Error('Seed verification failed: ' + collection + ' changed or is incomplete.');
    }
    return { mode: 'verified', ...summary(actual, config), databaseChanges: 0, reconciliation: { matches: true } };
  }
  if (verifyOnly) return verify();
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const existing = await db.collection('sitesettings').findOne({ _id: markerId(config) }, { session });
      if (existing) { result = { mode: 'already-applied', batch: config.batch, ...await verify(session) }; result.mode = 'already-applied'; return; }
      const current = await readDependencies(db, session);
      if (recovery.digest(current) !== artifact.sourceFingerprint) throw Error('Customer verification, staff or catalog inputs changed. Prepare a fresh preview.');
      assertAccountLinks(artifact.seed, current);
      for (const collection of Object.keys(COLLECTIONS)) {
        const Model = require('../models/' + COLLECTIONS[collection]);
        for (const row of artifact.seed[collection]) await new Model(row, undefined, { strict: 'throw' }).validate();
        await db.collection(collection).insertMany(artifact.seed[collection], { session, ordered: true });
      }
      result = await verify(session);
      await db.collection('sitesettings').insertOne({ _id: markerId(config), key: `${OPERATION}:${config.batch}`, value: {
        operation: OPERATION, batch: config.batch, seedFingerprint: artifact.seedFingerprint, configuration: config, appliedAt: now,
        counts: result.linkedRecords, sourceFingerprint: artifact.sourceFingerprint, backupFile: require('node:path').basename(backupFile),
      }, createdAt: now, updatedAt: now }, { session });
      await db.collection('activitylogs').insertOne({ _id: seedId(config.batch, 'audit'), action: 'demonstration.history_seed', category: 'system', module: 'TransactionHistorySeed',
        actorName: 'Demonstration seed', actorRole: 'System', source: 'system', outcome: 'success', riskLevel: 'info',
        details: { batch: config.batch, primaryTransactions: config.count, collections: result.linkedRecords, notice: NOTICE, emails: 0, physicalStockChanges: 0 }, createdAt: now, updatedAt: now }, { session });
      result = { ...result, mode: 'seeded', atomic: true, databaseChanges: Object.values(result.linkedRecords).reduce((sum, value) => sum + value, 0) + 2,
        message: 'Demonstration transactions inserted and reconciled. Existing transactions, accounts, inventory, payroll and expenses were preserved.' };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 30000 });
  } finally { await session.endSession(); }
  return result;
}

module.exports = { DEFAULTS, OPERATION, COLLECTIONS, configuration, eligibleCustomer, eligibleTechnicians, productChoices, serviceChoices, repairChoices,
  prerequisites, readDependencies, buildSeed, assertAccountLinks, assertSeedIntegrity, summary, previewSeed, applySeed, seedId, markerId };
