require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');

async function run() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("FATAL: MONGODB_URI environment variable is required. Exiting.");
    process.exit(1);
  }
  const email = (process.env.ADMIN_EMAIL || 'calidroracs@gmail.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'Racs_Ready1702';

  // Profile defaults (use env overrides when present)
  const defaultFirst = process.env.ADMIN_FIRSTNAME || 'Admin';
  const defaultLast = process.env.ADMIN_LASTNAME || 'User';
  const defaultPhone = (process.env.ADMIN_PHONE || '0000000000').replace(/\D+/g, '').slice(0, 32) || '0000000000';

  if (!email || !password) {
    console.error('Please set ADMIN_EMAIL and ADMIN_PASSWORD environment variables.');
    process.exit(2);
  } 

  console.log('Connecting to', mongoUri);
  await mongoose.connect(mongoUri);

  try {
    let user = await User.findOne({ email });

    if (!user) {
      // create with required profile fields to satisfy User schema
      user = new User({
        email,
        role: 'admin',
        active: true,
        firstName: defaultFirst,
        lastName: defaultLast,
        phone: defaultPhone
      });
      await user.setPassword(password);
      await user.save();
      console.log('Admin user created:', email);
      await ActivityLog.create({ actor: null, target: user._id, action: 'admin.created', ip: 'script', details: { createdBy: 'createAdmin.js' } });
    } else {
      // ensure required profile fields exist (avoid save-time validation errors)
      const missing = [];
      if (!user.firstName) { user.firstName = defaultFirst; missing.push('firstName'); }
      if (!user.lastName) { user.lastName = defaultLast; missing.push('lastName'); }
      if (!user.phone) { user.phone = defaultPhone; missing.push('phone'); }

      user.role = 'admin';
      user.active = true;
      await user.setPassword(password);
      await user.save();

      if (missing.length) console.log('createAdmin: filled missing fields for existing user:', missing.join(', '));
      console.log('Admin user updated (password/role):', email);
      await ActivityLog.create({ actor: null, target: user._id, action: 'admin.updated', ip: 'script', details: { updatedBy: 'createAdmin.js', filled: missing } });
    }
  } catch (e) {
    console.error('Failed to create/update admin user:', e && e.message ? e.message : e);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }

  process.exit(0);
}

run().catch(err => {
  console.error('Script error:', err && err.message ? err.message : err);
  process.exit(1);
});
