/**
 * Simple seed script to create a test user for development.
 * Usage: NODE_ENV=development node server/scripts/seedUser.js
 */

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const User = require("../models/User");

dotenv.config();

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB");

  const testEmail = process.env.SEED_TEST_EMAIL || "test@example.com";
  // ensure default seed password is alphanumeric and within allowed length for the app's login validator
  const testPassword = (process.env.SEED_TEST_PASSWORD || "Password123")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 12);
  const testFirstName = process.env.SEED_TEST_FIRSTNAME || "Test";
  const testLastName = process.env.SEED_TEST_LASTNAME || "User";
  const testPhone =
    (process.env.SEED_TEST_PHONE || "09171234567")
      .replace(/\D+/g, "")
      .slice(0, 32) || "09171234567";

  let user = await User.findOne({ email: testEmail });
  if (user) {
    // ensure required profile fields exist for existing user (avoid validation errors)
    const missing = [];
    if (!user.firstName) {
      user.firstName = testFirstName;
      missing.push("firstName");
    }
    if (!user.lastName) {
      user.lastName = testLastName;
      missing.push("lastName");
    }
    if (!user.phone) {
      user.phone = testPhone;
      missing.push("phone");
    }
    if (missing.length) {
      await user.save();
      console.log(
        "Filled missing fields for existing user:",
        missing.join(", "),
      );
    } else {
      console.log("User already exists:", testEmail);
    }
  } else {
    user = new User({
      email: testEmail,
      firstName: testFirstName,
      lastName: testLastName,
      phone: testPhone,
    });
    await user.setPassword(testPassword);
    await user.save();
    console.log("Created user:", testEmail);
  }

  console.log(
    "You can now test the password reset flow by calling /forgot-password for this email.",
  );
  console.log(`Credentials -> ${testEmail} / ${testPassword}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
