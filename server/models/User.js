const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const violationSchema = new mongoose.Schema(
  {
    type: { type: String },
    message: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  },
  // Customer profile fields
  firstName: { type: String, trim: true, required: true },
  lastName: { type: String, trim: true, required: true },
  phone: {
    type: String,
    trim: true,
    required: true,
    match: [/^\d+$/, "Phone must contain digits only"],
  },
  address: {
    province: { type: String, trim: true },
    city: { type: String, trim: true },
    barangay: { type: String, trim: true },
    postalCode: { type: String, trim: true },
  },
  passwordHash: { type: String, required: true },
  role: {
    type: String,
    enum: ["customer", "admin", "secretary", "technician"],
    default: "customer",
  },
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  resetPasswordTokenHash: String,
  resetPasswordExpires: Date,
  lastPasswordChange: Date,
  // Existing accounts and staff remain verified by default. Public registration
  // explicitly sets this to false until the email OTP is confirmed.
  emailVerified: { type: Boolean, default: true, index: true },
  emailVerifiedAt: Date,
  emailVerificationOtpHash: { type: String, select: false },
  emailVerificationExpires: { type: Date, select: false },
  emailVerificationLastSentAt: { type: Date, select: false },
  emailVerificationAttempts: { type: Number, default: 0, select: false },
  // Admin / policy fields
  blocked: { type: Boolean, default: false },
  vip: { type: Boolean, default: false },
  violations: { type: [violationSchema], default: [] },
  bookingLimit: { type: Number, default: 0 },
  // For staff accounts
  active: { type: Boolean, default: true },
  // Current server-side session id for token revocation
  currentSessionId: { type: String },
  // Per-user permission overrides — when set, these take precedence over role defaults
  permissions: { type: [String], default: undefined },
});

// computed fields for convenient display
userSchema.virtual("fullName").get(function () {
  const fn = this.firstName || "";
  const ln = this.lastName || "";
  return (fn + " " + ln).trim();
});
userSchema.virtual("name").get(function () {
  // alias for fullName (legacy code uses both)
  return this.fullName;
});

// ensure virtuals are included in toObject/toJSON
userSchema.set("toObject", { virtuals: true });
userSchema.set("toJSON", { virtuals: true });

// Create a reset token (unhashed token returned, hashed version stored)
userSchema.methods.createPasswordResetToken = function () {
  const token = require("crypto").randomBytes(32).toString("hex");
  const hash = require("crypto")
    .createHash("sha256")
    .update(token)
    .digest("hex");
  this.resetPasswordTokenHash = hash;
  const defaultMs = 15 * 60 * 1000; // 15 minutes (fallback)
  const ttl = Number(process.env.RESET_PASSWORD_TOKEN_EXPIRES_MS) || defaultMs;
  this.resetPasswordExpires = Date.now() + ttl;
  return token;
};

userSchema.methods.clearPasswordReset = function () {
  this.resetPasswordTokenHash = undefined;
  this.resetPasswordExpires = undefined;
};

userSchema.methods.setPassword = async function (password) {
  const saltRounds = 12;
  this.passwordHash = await bcrypt.hash(password, saltRounds);
  this.lastPasswordChange = new Date();
};

// Compare provided password with stored hash
userSchema.methods.comparePassword = function (password) {
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.methods.addViolation = function (type, message) {
  this.violations = this.violations || [];
  this.violations.push({ type, message, createdAt: new Date() });
};

// Hide sensitive fields when converting to JSON
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.resetPasswordTokenHash;
  delete obj.resetPasswordExpires;
  delete obj.emailVerificationOtpHash;
  delete obj.emailVerificationExpires;
  delete obj.emailVerificationLastSentAt;
  delete obj.emailVerificationAttempts;
  delete obj.currentSessionId;
  return obj;
};

// Performance indexes
userSchema.index({ role: 1 });
userSchema.index({ role: 1, createdAt: -1 });

module.exports = mongoose.model("User", userSchema);
