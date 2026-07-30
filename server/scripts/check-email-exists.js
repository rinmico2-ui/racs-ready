const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const email = 'xiejustina50@gmail.com';
    const user = await User.findOne({ email });
    console.log('user found?', !!user);
    if (user) console.log('stored email:', user.email, 'id:', user._id.toString());
  } catch (err) {
    console.error('error:', err && err.message);
  } finally {
    await mongoose.disconnect();
  }
}

run();
