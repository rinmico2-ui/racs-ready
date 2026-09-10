
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');

// ============================================================
// MongoDB configuration
// ============================================================

const MONGODB_URI = process.env.MONGODB_URI;

// Your MongoDB Atlas hosts.
// These were obtained from the SRV lookup for your cluster.
const MONGODB_DIRECT_HOSTS = [
  'ac-8z2eogy-shard-00-00.zg3zjgk.mongodb.net:27017',
  'ac-8z2eogy-shard-00-01.zg3zjgk.mongodb.net:27017',
  'ac-8z2eogy-shard-00-02.zg3zjgk.mongodb.net:27017'
];

const MONGODB_REPLICA_SET =
  process.env.MONGODB_REPLICA_SET || 'atlas-8z2eogy-shard-0';

const MONGODB_AUTH_SOURCE =
  process.env.MONGODB_AUTH_SOURCE || 'admin';

// ============================================================
// Admin configuration
// ============================================================

const email = (
  process.env.ADMIN_EMAIL ||
  'lestherneilclemente1@gmail.com'
)
  .trim()
  .toLowerCase();

const password =
  process.env.ADMIN_PASSWORD || 'Racs1234';

const defaultFirst =
  process.env.ADMIN_FIRSTNAME || 'Admin';

const defaultLast =
  process.env.ADMIN_LASTNAME || 'User';

const defaultPhone =
  (
    process.env.ADMIN_PHONE ||
    '0000000000'
  )
    .replace(/\D+/g, '')
    .slice(0, 32) || '0000000000';

// ============================================================
// Build direct MongoDB URI
// ============================================================

function buildDirectMongoUri() {
  if (!MONGODB_URI) {
    throw new Error(
      'MONGODB_URI environment variable is required.'
    );
  }

  let parsed;

  try {
    parsed = new URL(MONGODB_URI);
  } catch (err) {
    throw new Error(
      `Invalid MONGODB_URI: ${err.message}`
    );
  }

  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);

  const credentials =
    `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;

  const hosts = MONGODB_DIRECT_HOSTS.join(',');

  return (
    `mongodb://${credentials}@${hosts}/test` +
    `?replicaSet=${encodeURIComponent(MONGODB_REPLICA_SET)}` +
    `&authSource=${encodeURIComponent(MONGODB_AUTH_SOURCE)}` +
    `&tls=true`
  );
}

// ============================================================
// Connect to MongoDB
// ============================================================

async function connectToMongoDB() {
  if (!MONGODB_URI) {
    throw new Error(
      'FATAL: MONGODB_URI environment variable is required.'
    );
  }

  console.log('Attempting MongoDB connection...');

  // ----------------------------------------------------------
  // First attempt:
  // Normal MongoDB Atlas mongodb+srv URI
  // ----------------------------------------------------------

  try {
    console.log(
      'Trying standard MongoDB Atlas connection...'
    );

    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    });

    console.log(
      'MongoDB connected successfully using MONGODB_URI.'
    );

    return;
  } catch (err) {
    console.error(
      'Standard MongoDB connection failed:',
      err.message
    );

    // Make sure the failed connection is completely closed
    try {
      await mongoose.disconnect();
    } catch (_) {
      // Ignore disconnect errors
    }
  }

  // ----------------------------------------------------------
  // Second attempt:
  // Direct Atlas hosts
  // ----------------------------------------------------------

  console.log(
    'Trying MongoDB Atlas direct-host fallback...'
  );

  const directUri = buildDirectMongoUri();

  // Do NOT print the URI because it contains credentials.

  try {
    await mongoose.connect(directUri, {
      serverSelectionTimeoutMS: 15000
    });

    console.log(
      'MongoDB connected successfully using direct hosts.'
    );
  } catch (err) {
    console.error(
      'Direct MongoDB connection also failed:',
      err.message
    );

    throw err;
  }
}

// ============================================================
// Create / update administrator
// ============================================================

async function createOrUpdateAdmin() {
  console.log(
    `Processing administrator account: ${email}`
  );

  let user = await User.findOne({ email });

  if (!user) {
    // --------------------------------------------------------
    // Create new administrator
    // --------------------------------------------------------

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

    console.log(
      'Admin user created successfully:',
      email
    );

    await ActivityLog.create({
      actor: null,
      target: user._id,
      action: 'admin.created',
      ip: 'script',
      details: {
        createdBy: 'createAdmin.js'
      }
    });

    console.log(
      'Admin creation activity logged.'
    );
  } else {
    // --------------------------------------------------------
    // Update existing administrator
    // --------------------------------------------------------

    const missing = [];

    if (!user.firstName) {
      user.firstName = defaultFirst;
      missing.push('firstName');
    }

    if (!user.lastName) {
      user.lastName = defaultLast;
      missing.push('lastName');
    }

    if (!user.phone) {
      user.phone = defaultPhone;
      missing.push('phone');
    }

    user.role = 'admin';
    user.active = true;

    await user.setPassword(password);
    await user.save();

    if (missing.length > 0) {
      console.log(
        'Filled missing fields:',
        missing.join(', ')
      );
    }

    console.log(
      'Admin user updated successfully:',
      email
    );

    await ActivityLog.create({
      actor: null,
      target: user._id,
      action: 'admin.updated',
      ip: 'script',
      details: {
        updatedBy: 'createAdmin.js',
        filled: missing
      }
    });

    console.log(
      'Admin update activity logged.'
    );
  }
}

// ============================================================
// Main
// ============================================================

async function run() {
  try {
    // Validate admin configuration
    if (!email || !password) {
      throw new Error(
        'ADMIN_EMAIL and ADMIN_PASSWORD are required.'
      );
    }

    // Connect to MongoDB
    await connectToMongoDB();

    // Create or update admin
    await createOrUpdateAdmin();

    console.log(
      '========================================'
    );
    console.log(
      'Admin setup completed successfully.'
    );
    console.log(
      '========================================'
    );

    process.exitCode = 0;
  } catch (err) {
    console.error(
      '========================================'
    );
    console.error(
      'Admin setup failed.'
    );
    console.error(
      '========================================'
    );
    console.error(
      err && err.message
        ? err.message
        : err
    );

    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
      console.log('MongoDB connection closed.');
    } catch (err) {
      console.error(
        'Error closing MongoDB connection:',
        err.message
      );
    }
  }
}

// Start script
run();

