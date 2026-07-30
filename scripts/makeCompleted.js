const mongoose = require('mongoose');
(async () => {
  try {
    await mongoose.connect('mongodb://localhost:27017/appointment_scheduler');
    const BookingService = require('../server/models/BookingService');
    let one = await BookingService.findOne();
    if (!one) {
      // create a dummy if none exist
      one = await BookingService.create({
        status: 'confirmed',
        bookingDate: new Date(),
        service: 'dummy',
        bookingReference: 'AUTO'+Date.now(),
        startTime: '0',
        serviceDurationMinutes: 60,
      });
      console.log('created dummy', one._id);
    }
    one.status = 'completed';
    await one.save();
    console.log('updated to completed', one._id);
    const cnt = await BookingService.countDocuments({ status: 'completed' });
    console.log('completed count', cnt);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
