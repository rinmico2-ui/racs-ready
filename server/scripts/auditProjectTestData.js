"use strict";
// Read-only: never applies deletions, indexes, updates, or emails.
const fs = require('node:fs'), path = require('node:path');
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require('../utils/mongoConnection');
const { buildRevenueAnalytics } = require('../utils/revenueAnalytics');
const { paymentAmounts } = require('../utils/enterpriseRevenue');
const id = value => value ? String(value) : null;
(async () => {
  if (!process.env.MONGODB_URI) throw Error('Missing configuration');
  const settings = buildMongoConnectionUri(process.env.MONGODB_URI, { directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE });
  await mongoose.connect(disableRetryableWritesForDirectConnection(settings.uri), { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, socketTimeoutMS: 20000, maxPoolSize: 2, autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  const projects = await db.collection('projects').find({}, { projection: { bookingId: 1, sourceOrderId: 1, 'customer.name': 1, 'service.name': 1, status: 1, projectPhase: 1, totalUnits: 1, totalEstimatedHours: 1, archivedAt: 1, testDataExcludedAt: 1, createdAt: 1, assignedTechnicians: 1 } }).limit(300).maxTimeMS(10000).toArray();
  const payments = await db.collection('payments').find({}, { projection: { bookingId: 1, orderId: 1, projectId: 1, amount: 1, refundAmount: 1, refundStatus: 1, testDataExcludedAt: 1, status: 1, refundedAt: 1, verifiedAt: 1, collectedAt: 1, submittedAt: 1, completedAt: 1 } }).limit(10000).maxTimeMS(10000).toArray();
  const bookings = await db.collection('bookingservices').find({}, { projection: { status: 1, serviceType: 1, createdAt: 1, completedAt: 1, totalPrice: 1, estimatedFee: 1, cancelledAt: 1, paymentStatus: 1 } }).limit(10000).maxTimeMS(10000).toArray();
  const orders = await db.collection('orders').find({}, { projection: { status: 1, createdAt: 1, completedAt: 1, total: 1, projectId: 1, bookingId: 1, orderReference: 1 } }).limit(10000).maxTimeMS(10000).toArray();
  const counts = await Promise.all(['projects','payments','bookingservices','orders'].map(name => db.collection(name).countDocuments({}, { maxTimeMS: 10000 })));
  const bmap = new Map(bookings.map(row => [id(row._id), row])), omap = new Map(orders.map(row => [id(row._id), row]));
  const pmap = new Map(projects.map(row => [id(row._id), row])), pbyb = new Map(projects.filter(row => row.bookingId).map(row => [id(row.bookingId), row]));
  const refunds = payments.filter(row => Number(row.refundAmount) > 0).map(row => {
    const booking = bmap.get(id(row.bookingId)), order = omap.get(id(row.orderId)), project = pmap.get(id(row.projectId)) || pbyb.get(id(row.bookingId));
    return { id: id(row._id), bookingId: id(row.bookingId), projectId: id(project?._id || row.projectId), orderId: id(row.orderId),
      amount: row.amount, refundAmount: row.refundAmount, countedRefund: paymentAmounts(row).refunded, paymentStatus: row.status, refundStatus: row.refundStatus, testDataExcludedAt: row.testDataExcludedAt,
      refundedAt: row.refundedAt, collectedAt: row.verifiedAt || row.completedAt || row.collectedAt || row.submittedAt,
      bookingStatus: booking?.status, bookingCompletedAt: booking?.completedAt, orderStatus: order?.status, orderCompletedAt: order?.completedAt,
      projectArchived: Boolean(project?.archivedAt), customer: project?.customer?.name, missingParent: !booking && !order && !project };
  }).sort((a,b) => Number(b.refundAmount) - Number(a.refundAmount));
  const projectRows = projects.map(row => {
    const linked = payments.filter(payment => id(payment.projectId) === id(row._id) || (row.bookingId && id(payment.bookingId) === id(row.bookingId)) || (row.sourceOrderId && id(payment.orderId) === id(row.sourceOrderId)));
    return { id: id(row._id), customer: row.customer?.name, service: row.service?.name, status: row.status, phase: row.projectPhase, units: row.totalUnits,
      createdAt: row.createdAt, archivedAt: row.archivedAt, bookingId: id(row.bookingId), bookingStatus: bmap.get(id(row.bookingId))?.status,
      sourceOrderId: id(row.sourceOrderId), orderStatus: omap.get(id(row.sourceOrderId))?.status, crewCount: row.assignedTechnicians?.length || 0,
      payments: linked.length, grossPayments: linked.reduce((sum,payment) => sum + paymentAmounts(payment).gross, 0),
      refunds: linked.reduce((sum,payment) => sum + paymentAmounts(payment).refunded, 0), testNameCandidate: /test|demo|sample/i.test(row.customer?.name || '') };
  });
  const summaries = [];
  for (const query of [{}, { period: 'this_month' }]) {
    const { filters, analytics: a } = await buildRevenueAnalytics(query);
    summaries.push({ query, range: { from: filters.startDate, to: filters.endDate }, bookedValue: a.totalRevenue, completedGross: a.recognizedGrossRevenue,
      completedNet: a.recognizedRevenue, refunds: a.refunds, grossCollections: a.grossCollections, netCollections: a.netCollections,
      outstanding: a.outstandingValue, operatingProfit: a.operatingProfit, completedCount: a.recognizedTransactions, refundCount: a.refundCount });
  }
  const report = { generatedAt: new Date().toISOString(), mode: 'read-only', counts: Object.fromEntries(['projects','payments','bookingservices','orders'].map((key,i) => [key,counts[i]])),
    capped: counts[0] > 300 || counts.slice(1).some(count => count > 10000), projects: projectRows, refunds, summaries };
  const directory = path.resolve(__dirname, '../../temp'); fs.mkdirSync(directory, { recursive: true }); const target = path.join(directory, 'live-project-refund-audit.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(JSON.stringify({ error: error.name, code: error.code || null,
  causes: [...(error.reason?.servers?.values() || [])].map(server => ({ type: server.error?.name, code: server.error?.cause?.code || server.error?.code || null })),
  detail: 'Read-only audit failed; no data was changed.' })); process.exitCode = 1; }).finally(() => mongoose.disconnect());
