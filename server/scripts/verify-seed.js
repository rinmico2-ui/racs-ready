const dns = require('dns');
dns.setServers(['8.8.8.8']);
dns.resolveSrv = function (hostname, cb) {
  const resolver = new dns.Resolver();
  resolver.setServers(['8.8.8.8']);
  resolver.resolveSrv(hostname, cb);
};
const mongoose = require('mongoose');
require('dotenv').config();
async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const BookingService = require('../models/BookingService');
  const Assignment = require('../models/Assignment');
  const start = new Date('2026-08-19T00:00:00');
  const end = new Date('2026-08-20T00:00:00');
  const bookings = await BookingService.find({
    bookingDate: { $gte: start, $lt: end },
    bookingReference: { $regex: /^BK-SEED-/ }
  }).select('bookingReference serviceType serviceName bookingDate startTime status').lean();
  const assignments = await Assignment.find({
    bookingDate: { $gte: start, $lt: end },
    status: 'accepted'
  }).select('bookingId serviceName status preparationStatus').lean();
  console.log('Bookings for Aug 19:', bookings.length);
  bookings.forEach(b => console.log('  -', b.startTime, b.serviceName, '(' + b.serviceType + ')', b.status, b.bookingReference));
  console.log('\nAssignments:', assignments.length);
  assignments.forEach(a => console.log('  -', a.serviceName, a.status, 'prep:', a.preparationStatus));
  await mongoose.disconnect();
}
run().catch(e => console.error(e));
