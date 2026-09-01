const express = require("express");
const logger = require("./utils/logger").create("server");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const mongoose = require("mongoose");
const path = require("path");
const expressEjsLayouts = require("express-ejs-layouts");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const attachCurrentUser = require("./middleware/currentUser");
const User = require("./models/User");
const dns = require("dns");
const rateLimit = require("express-rate-limit");
const { requireTrustedOrigin } = require("./middleware/apiSecurity");
const apiAuth = require("./middleware/authenticate");
const { isAccountEnabled } = require("./middleware/accountState");

// ── Fail-fast: require critical secrets before anything else boots ──────────
if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is required. Exiting.");
  process.exit(1);
}
if (!process.env.SESSION_SECRET && !process.env.JWT_SECRET) {
  console.error("FATAL: SESSION_SECRET (or JWT_SECRET) environment variable is required. Exiting.");
  process.exit(1);
}

// Build allowed CORS origins from env vars
const ALLOWED_ORIGINS = [
  process.env.APP_URL,
  process.env.APP_BASE_URL,
].filter(Boolean);

const app = express();

// Database connection
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb://localhost:27017/appointment_scheduler";

// Never write database credentials from the connection URI to application logs.
logger.info("Connecting to MongoDB");

const databaseReady = mongoose
  .connect(MONGODB_URI)
  .then(async (mongooseInstance) => {
    logger.info("MongoDB connected successfully");
    // Seed default roles (idempotent — only creates roles that don't exist yet)
    try {
      const seedRoles = require("./scripts/seedRoles");
      await seedRoles();
    } catch (e) {
      logger.warn("Role seeding failed: %s", e && e.message);
    }

    // Safety net: ensure at least one admin account exists
    try {
      const User = require("./models/User");
      const adminCount = await User.countDocuments({ role: "admin" });
      if (adminCount === 0) {
        const email = (process.env.ADMIN_EMAIL || "xiejustina50@gmail.com").trim().toLowerCase();
        const password = process.env.ADMIN_PASSWORD || "ChangeMe123!";
        let admin = await User.findOne({ email });
        if (!admin) {
          admin = new User({
            email,
            role: "admin",
            active: true,
            firstName: process.env.ADMIN_FIRSTNAME || "Admin",
            lastName: process.env.ADMIN_LASTNAME || "User",
            phone: (process.env.ADMIN_PHONE || "0000000000").replace(/\D+/g, "").slice(0, 32) || "0000000000",
          });
          await admin.setPassword(password);
          await admin.save();
          logger.info("Auto-seeded admin account: %s", email);
        } else {
          admin.role = "admin";
          admin.active = true;
          await admin.setPassword(password);
          await admin.save();
          logger.info("Reactivated admin account (was last admin): %s", email);
        }
      }
    } catch (e) {
      logger.warn("Admin safety-net check failed: %s", e && e.message);
    }
    return mongooseInstance.connection.getClient();
  })
  .catch((err) => {
    logger.error("MongoDB connection error: %s", err.message);
    throw err;
  });

// Views Engine Setup
app.use(expressEjsLayouts);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("layout", "layouts/main");
app.set("view cache", false);

// Helmet Security Middleware - disable default CSP so we can set our own
app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

// Hide server information
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.removeHeader("Server");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// Content Security Policy - allow CDN resources used by the site
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
    // allow leaflet from unpkg if any page still references it, and other CDNs
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://www.gstatic.com https://www.recaptcha.net; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://maps.googleapis.com https://maps.gstatic.com; " +
    "img-src 'self' data: blob: https://cdn.jsdelivr.net https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://www.gstatic.com https://www.recaptcha.net https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org https://*.tile.openstreetmap.org https://a.basemaps.cartocdn.com https://b.basemaps.cartocdn.com https://c.basemaps.cartocdn.com https://d.basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://*.arcgisonline.com https://api.qrserver.com; " +
    "connect-src 'self' data: https://cdn.jsdelivr.net https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://www.gstatic.com https://www.recaptcha.net https://psgc.cloud https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org https://*.tile.openstreetmap.org https://a.basemaps.cartocdn.com https://b.basemaps.cartocdn.com https://c.basemaps.cartocdn.com https://d.basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://*.arcgisonline.com https://nominatim.openstreetmap.org https://api.qrserver.com https://unpkg.com https://router.project-osrm.org ws://localhost:* wss://localhost:*; " +
    "font-src 'self' data: https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
    "frame-src 'self' https://www.google.com https://www.gstatic.com https://www.recaptcha.net; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';",
  );
  next();
});

app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
}));

// request logging middleware (small overhead)
app.use((req, res, next) => {
  const start = process.hrtime();
  res.on("finish", () => {
    const diff = process.hrtime(start);
    const ms = diff[0] * 1e3 + diff[1] / 1e6;
    logger.http(
      "%s %s %d %dms",
      req.method,
      req.path,
      res.statusCode,
      ms.toFixed(1),
    );
  });
  next();
});
// Trust first proxy (required on Render/reverse-proxy hosts for rate-limiting)
app.set('trust proxy', 1);

// Force IPv4 for outbound connections (fixes ENETUNREACH on Render)
dns.setDefaultResultOrder('ipv4first');

// ── Rate Limiters ──────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: "Too many attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // 20 chat messages per minute
  message: { error: "Too many messages, please slow down" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Throttle and reject untrusted browser mutations before parsing potentially
// large request bodies.
app.use("/api", apiLimiter, requireTrustedOrigin);
app.use("/appointments", apiLimiter, requireTrustedOrigin);

// Some payment proofs still arrive as base64 payloads.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// express-session (server-side sessions)
const session = require("express-session");
const MongoStore = require("connect-mongo");
const SESSION_TTL = Number(process.env.SESSION_TTL_MS) || 30 * 60 * 1000; // ms
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.JWT_SECRET;

// Use a persistent session store so valid logins survive development restarts.
const sessionStore = MongoStore.create({
  clientPromise: databaseReady,
  ttl: Math.floor(SESSION_TTL / 1000),
});
// Suppress "Unable to find the session to touch" warnings from stale cookies
sessionStore.on("error", (err) => {
  logger.warn("MongoStore session error: %s", err && err.message);
});

app.use(
  session({
    name: "sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict",
      maxAge: SESSION_TTL,
    },
  }),
);

// Attach the current user to templates/res.locals when possible (non-blocking)
app.use(attachCurrentUser);

// Prevent NoSQL injection by sanitizing any keys containing '$' or '.' from request data
const mongoSanitize = require("express-mongo-sanitize");
// Use in-place sanitization to avoid reassigning req.query (which can be a getter-only property in some environments)
app.use(function (req, res, next) {
  try {
    if (req.body && typeof req.body === "object")
      mongoSanitize.sanitize(req.body);
    if (req.params && typeof req.params === "object")
      mongoSanitize.sanitize(req.params);
    if (req.headers && typeof req.headers === "object")
      mongoSanitize.sanitize(req.headers);
    if (req.query && typeof req.query === "object")
      mongoSanitize.sanitize(req.query);
  } catch (err) {
    // don't break request flow for sanitization errors
    console.warn("mongo-sanitize failed:", err && err.message);
  }
  next();
});

// Evidence and payment uploads are not public assets. Authentication is
// checked before static delivery; financial proofs are restricted to staff.
app.use(
  ["/uploads/gcash-receipts", "/uploads/project-payment-proofs"],
  apiAuth.authenticate,
  apiAuth.requireRole(["admin", "secretary"]),
);
app.use(
  [
    "/uploads/repairs",
    "/uploads/repair-photos",
    "/uploads/proofs",
    "/uploads/completion-proofs",
    "/uploads/expense-receipts",
    "/uploads/project-work-submissions",
    "/uploads/project-completion-proofs",
  ],
  apiAuth.authenticate,
);
app.use(express.static(path.join(__dirname, "public")));

// ── Global company info middleware ──────────────────────────────────────────
// Fetches company profile from SiteSetting so the footer and other public
// partials have access without each route needing to pass it manually.
const SiteSetting = require("./models/SiteSetting");
const _companyCache = { data: null, ts: 0 };
const COMPANY_CACHE_TTL = 60_000; // 1 minute

async function getCompanyInfo() {
  const now = Date.now();
  if (_companyCache.data && now - _companyCache.ts < COMPANY_CACHE_TTL) {
    return _companyCache.data;
  }
  try {
    const keys = [
      "companyName",
      "companyTagline",
      "companyPhone",
      "companyEmail",
      "companyLocationAddress",
    ];
    const docs = await SiteSetting.find({ key: { $in: keys } }).lean();
    const map = {};
    for (const d of docs) map[d.key] = d.value;
    const info = {
      companyName: map.companyName || "CALIDRO RACS",
      companyTagline: map.companyTagline || "Premium air conditioning & appliance care powered by transparent service and certified technicians.",
      companyPhone: map.companyPhone || "0965 605 6495",
      companyEmail: map.companyEmail || "calidroracs@gmail.com",
      companyAddress: map.companyLocationAddress || "San Leonardo, Nueva Ecija",
    };
    _companyCache.data = info;
    _companyCache.ts = now;
    return info;
  } catch {
    return {
      companyName: "CALIDRO RACS",
      companyTagline: "Premium air conditioning & appliance care powered by transparent service and certified technicians.",
      companyPhone: "0965 605 6495",
      companyEmail: "calidroracs@gmail.com",
      companyAddress: "San Leonardo, Nueva Ecija",
    };
  }
}
app.use(async (req, res, next) => {
  try {
    const info = await getCompanyInfo();
    res.locals.companyName = info.companyName;
    res.locals.companyTagline = info.companyTagline;
    res.locals.companyPhone = info.companyPhone;
    res.locals.companyEmail = info.companyEmail;
    res.locals.companyAddress = info.companyAddress;
  } catch { /* ignore – defaults are in the template */ }
  next();
});

// Routes
const pageRoutes = require("./routes/pages");
app.use("/", pageRoutes);

// API routes
const productRoutes = require("./routes/productRoutes");
app.use("/api/products", productRoutes);

const orderRoutes = require("./routes/orderRoutes");
app.use("/api/orders", orderRoutes);

const maintenanceRoutes = require("./routes/maintenanceRoutes");
app.use("/api/maintenance", maintenanceRoutes);

const warrantyRoutes = require("./routes/warrantyRoutes");
app.use("/api/warranty-claims", warrantyRoutes);

const airconCartRoutes = require("./routes/airconCartRoutes");
app.use("/api/aircon-cart", airconCartRoutes);

const serviceRoutes = require("./routes/serviceRoutes");
app.use("/api/services", serviceRoutes);

const scheduleRoutes = require("./routes/scheduleRoutes");
app.use("/api/schedule", scheduleRoutes);

const geocodingRoutes = require("./routes/geocodingRoutes");
app.use("/api/geocoding", geocodingRoutes);

const bookingRoutes = require("./routes/bookingRoutes");
app.use("/api/bookings", bookingRoutes);

const bookingRoutesNew = require("./routes/bookingRoutesNew");
app.use("/api/bookings", bookingRoutesNew);

const appointmentRoutes = require("./routes/appointmentRoutes");
console.log("[startup] appointmentRoutes type", typeof appointmentRoutes);
if (appointmentRoutes && typeof appointmentRoutes === "function") {
  app.use("/api/appointments", appointmentRoutes);
  // Mount the same routes at /appointments so client-side code that posts to /appointments
  // (UI) is protected by the same server-side authentication checks.
  app.use("/appointments", appointmentRoutes);
} else {
  console.warn(
    "Appointment routes could not be mounted (not a function):",
    appointmentRoutes,
  );
}

const userRoutes = require("./routes/userRoutes");
app.use("/api/users", userRoutes);

const authRoutes = require("./routes/authRoutes");
app.use("/api/auth", authLimiter, authRoutes);

const adminApi = require("./routes/adminApi");
app.use("/api/admin", adminApi);

// Public company/base location used for booking distance/fare calculations
const publicCompanyRoutes = require("./routes/publicCompanyRoutes");
app.use("/api/public/company", publicCompanyRoutes);


const hvacApi = require("./routes/hvacApi");
app.use("/api/admin", hvacApi);

const inventoryRoutes = require("./routes/inventoryRoutes");
app.use("/api/inventory", inventoryRoutes);

const posRoutes = require("./routes/posRoutes");
app.use("/api/pos", posRoutes);

const psgcRoutes = require("./routes/psgcRoutes");
app.use("/api/psgc", psgcRoutes);

// Secretary‑specific APIs (currently just analytics). Mounted separately so we
// can apply the "secretary" role check without exposing the entire admin
// namespace.
const hvacSecretaryApi = require("./routes/hvacSecretaryApi");
app.use("/api/secretary", hvacSecretaryApi);

const secretaryApi = require("./routes/secretaryApi");
app.use("/api/secretary", secretaryApi);

const technicianApi = require("./routes/technicianApi");
app.use("/api/technician", technicianApi);

const payrollRoutes = require("./routes/payrollRoutes");
app.use("/api/payroll", payrollRoutes);

const bookingFlow = require("./routes/bookingFlow");
app.use("/api/booking-flow", bookingFlow);

// Enterprise Appointment Management API
const equipmentReturnRoutes = require("./routes/equipmentReturnRoutes");
app.use("/api/admin/appointments", equipmentReturnRoutes);
const appointmentManagement = require("./routes/appointmentManagement");
app.use("/api/admin/appointments", appointmentManagement);

// Enterprise Project Management API
const projectRoutes = require("./routes/projectRoutes");
app.use("/api", projectRoutes);

// rating endpoints (requires login but not admin)
const ratingApi = require("./routes/ratingApi");
app.use("/api/rating", ratingApi);

// Notifications API
const notificationRoutes = require("./routes/notifications");
app.use("/api/notifications", notificationRoutes);

// AI Chat API
const chatRoutes = require("./routes/chatRoutes");
app.use("/api/chat", chatLimiter, chatRoutes);

// Public holidays (supports multiple providers: google or nager)
const holidayRoutes = require("./routes/holidayRoutes");
app.use("/api/holidays", holidayRoutes);

// Online gateway processing is intentionally disabled. Payments are recorded
// manually by technicians and verified through the admin remittance workflow.

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.stack}`);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === "production";
  res.status(status).json({
    error: isProd && status >= 500 ? "Internal server error" : err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(Array.isArray(err.unavailable) ? { unavailable: err.unavailable } : {}),
  });
});

// Start the server
const PORT = process.env.PORT || 5000;
let server;

const shutdownSignals = ["SIGINT", "SIGTERM"];
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("%s received — shutting down gracefully", signal);
  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    logger.info("Server closed and MongoDB disconnected");
  } catch (err) {
    logger.error("Graceful shutdown error: %s", err && err.message);
  } finally {
    process.exit(0);
  }
}

shutdownSignals.forEach((signal) => {
  process.once(signal, () => gracefulShutdown(signal));
});

// Daily midnight reset for Technician statuses
let lastResetDateStr = "";
setInterval(async () => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    
    // Check if we already did the reset for today
    if (now.getHours() === 0 && lastResetDateStr !== todayStr) {
      const Technician = require("./models/Technician");
      
      const res = await Technician.updateMany({}, {
        $set: {
          availabilityStatus: "Offline"
        }
      });
      
      console.log(`[midnight-reset] Automatically reset technician statuses for ${todayStr}. Modified: ${res.modifiedCount}`);
      lastResetDateStr = todayStr;
    }
  } catch (err) {
    console.error("[midnight-reset] Error resetting technician statuses:", err);
  }
}, 60 * 60 * 1000); // check every hour
// ── Overdue Booking Scheduler ─────────────────────────────────────────────────
const { startOverdueScheduler } = require('./utils/overdueBookingScheduler');
const { startMaintenanceScheduler } = require('./utils/maintenanceScheduler');
const { startEquipmentReturnScheduler } = require('./utils/equipmentReturnScheduler');

// ── Overtime Delay Monitor ─────────────────────────────────────────────────
// Periodically scans active jobs that have overrun their buffered capacity end
// and auto-notifies (notify-only) any later same-technician bookings on the
// same day. See server/utils/delayNotifier.js.
const { startDelayMonitor } = require('./utils/delayNotifier');

function startBackgroundSchedulers() {
  startOverdueScheduler();
  startMaintenanceScheduler();
  startEquipmentReturnScheduler();
  startDelayMonitor();
}

const http = require("http");
server = http.createServer(app);

// ── Socket.io Setup for Live Tracking ────────────────────────────────────────
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

function parseCookies(header) {
  const h = header || "";
  return h
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const [k, ...v] = pair.split("=");
      acc[k] = decodeURIComponent(v.join("="));
      return acc;
    }, {});
}

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] },
  path: "/socket.io",
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: false,
  },
});

// ── Socket Auth Middleware ─────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const cookies = parseCookies(socket.handshake.headers.cookie || "");
    const token = cookies["auth_token"];
    if (!token) {
      return next(new Error("Authentication required"));
    }
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const user = await User.findById(payload.id).select("-passwordHash");
    if (!isAccountEnabled(user)) {
      return next(new Error("User not found"));
    }
    if (
      payload.sessionId &&
      payload.sessionId !== String(user.currentSessionId || "")
    ) {
      return next(new Error("Session expired"));
    }
    if (
      user.lastPasswordChange &&
      payload.iat &&
      payload.iat * 1000 < user.lastPasswordChange.getTime()
    ) {
      return next(new Error("Token expired"));
    }
    socket.user = user;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", async (socket) => {
  console.log("[socket] client connected:", socket.id, "user:", socket.user._id);

  socket.join("user:" + socket.user._id);
  if (socket.user.role === "customer") socket.join("customer:" + socket.user._id);
  if (["admin", "secretary"].includes(socket.user.role)) socket.join("admin-room");
  if (socket.user.role === "technician") {
    const Technician = require("./models/Technician");
    const ownTechnician = await Technician.findOne({ user: socket.user._id })
      .select("_id name")
      .lean()
      .catch(() => null);
    if (ownTechnician) {
      socket.technicianId = String(ownTechnician._id);
      socket.technicianName = ownTechnician.name || "Technician";
      socket.join("tech:" + socket.technicianId);
    }
  }

  // Technician shares location
  socket.on("tech:location", async (data = {}) => {
    if (socket.user.role !== "technician" && socket.user.role !== "admin") return;
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    const techId = socket.user.role === "technician" ? socket.technicianId : String(data.techId || "");
    if (!techId || !mongoose.Types.ObjectId.isValid(techId)) return;
    io.to("admin-room").emit("tech:location:update", {
      techId,
      name: socket.user.role === "technician" ? socket.technicianName : String(data.name || "Technician").slice(0, 100),
      lat,
      lng,
      status: String(data.status || "").slice(0, 50),
      timestamp: Date.now(),
    });
  });

  // ── GPS Update from technician tracker ──────────────────────────────────
  socket.on("gps:update", async (data) => {
    try {
      if (socket.user.role !== "technician" && socket.user.role !== "admin") return;
      const { bookingId } = data || {};
      const lat = Number(data && data.lat);
      const lng = Number(data && data.lng);
      const accuracy = Number(data && data.accuracy);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

      const Technician = require("./models/Technician");
      const techId = socket.user.role === "technician" ? socket.technicianId : String(data.techId || "");
      if (!techId || !mongoose.Types.ObjectId.isValid(techId)) return;
      const updatedTechnician = await Technician.findOneAndUpdate(
        { _id: techId, active: true },
        { location: { type: "Point", coordinates: [lng, lat] } },
        { returnDocument: "after" },
      );
      if (!updatedTechnician) return;

      if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) {
        const BookingService = require("./models/BookingService");
        const booking = await BookingService.findOne({
          _id: bookingId,
          technicianId: techId,
          status: { $in: ["assigned", "confirmed", "scheduled", "on-the-way", "arrived", "in-progress", "ongoing"] },
        }).select("customerId").lean();
        if (booking && booking.customerId) io.to("customer:" + booking.customerId).emit("gps:location", {
          techId,
          lat,
          lng,
          accuracy: Number.isFinite(accuracy) ? accuracy : null,
          bookingId,
          timestamp: Date.now(),
        });
      }

      io.to("admin-room").emit("tech:location:update", {
        techId,
        lat,
        lng,
        accuracy,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error("[socket] gps:update error", err.message);
    }
  });

  // Admin sends assignment notification
  socket.on("admin:assignment", (data) => {
    if (socket.user.role !== "admin" && socket.user.role !== "secretary") return;
    io.to("tech:" + data.techId).emit("assignment:new", data);
  });

  // Technician joins their room for targeted notifications
  socket.on("tech:join", (techId) => {
    const id = typeof techId === 'object' ? (techId.techId || techId.id || '') : techId;
    if (!id) return;
    if (socket.user.role === "technician" && String(socket.technicianId) === String(id)) {
      socket.join("tech:" + socket.technicianId);
    } else if (["admin", "secretary"].includes(socket.user.role) && mongoose.Types.ObjectId.isValid(id)) {
      socket.join("tech:" + id);
    }
  });

  // Customer joins their room for targeted tracking updates
  socket.on("customer:join", (customerId) => {
    if (socket.user.role === "customer" && String(socket.user._id) === String(customerId)) {
      socket.join("customer:" + socket.user._id);
    } else if (["admin", "secretary"].includes(socket.user.role) && mongoose.Types.ObjectId.isValid(customerId)) {
      socket.join("customer:" + customerId);
    }
  });

  // Admin/secretary joins admin room for notifications
  socket.on("admin:join", () => {
    if (socket.user.role !== "admin" && socket.user.role !== "secretary") return;
    socket.join("admin-room");
    socket.join("user:" + socket.user._id);
  });

  // Technician joins their user room for personal notifications
  socket.on("tech:user-join", (userId) => {
    if (socket.user.role === "technician" && String(socket.user._id) === String(userId)) {
      socket.join("user:" + socket.user._id);
    }
  });

  socket.on("disconnect", () => {
    console.log("[socket] client disconnected:", socket.id);
  });
});

// Make io accessible to routes
app.set("io", io);
global._io = io;

// ── Acceptance deadline expiry watchdog ─────────────────────────────────────
setInterval(async () => {
  try {
    const Assignment = require("./models/Assignment");
    const BookingService = require("./models/BookingService");
    const Technician = require("./models/Technician");
    const { createNotification } = require("./utils/notify");

    function calculateAcceptanceDeadline(bookingDate, assignedAt) {
      const now = new Date(assignedAt || new Date());
      const bd = new Date(bookingDate);
      const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
      const startOfBooking = new Date(bd); startOfBooking.setHours(0, 0, 0, 0);
      const daysUntil = Math.round((startOfBooking - startOfToday) / (1000 * 60 * 60 * 24));
      if (daysUntil <= 0) return new Date(now.getTime() + 30 * 60 * 1000);
      if (daysUntil === 1) {
        const today6pm = new Date(now); today6pm.setHours(18, 0, 0, 0);
        if (today6pm > now) return today6pm;
        return new Date(now.getTime() + 30 * 60 * 1000);
      }
      return new Date(now.getTime() + 12 * 60 * 60 * 1000);
    }

    const now = new Date();
    const expired = await Assignment.find({
      status: "pending_acceptance",
      acceptanceDeadline: { $lt: now },
    }).lean();
    for (const a of expired) {
      const assignment = await Assignment.findById(a._id);
      assignment.status = "expired";
      assignment.expiredAt = now;
      assignment.expiredReason = "No response before deadline";
      assignment.notes.push({
        text: "Assignment expired: no response before deadline",
        by: null,
        byName: "System",
        createdAt: now,
      });
      await assignment.save();

      let reassigned = false;
      const booking = await BookingService.findById(assignment.bookingId);
      if (booking) {
        const isRepair = booking.serviceModel === "RepairService";
        const dayS = new Date(booking.bookingDate); dayS.setHours(0, 0, 0, 0);
        const dayE = new Date(booking.bookingDate); dayE.setHours(23, 59, 59, 999);
        // Keep admin control: an expired assignment returns to the queue.
        // The queue planner recommends the next eligible technician, but does
        // not send a new assignment until the admin reviews and confirms it.
        const candidates = [];

        let newTech = null;
        for (const t of candidates) {
          const conflictBooking = await BookingService.findOne({
            _id: { $ne: booking._id },
            technicianId: t._id,
            bookingDate: { $gte: dayS, $lte: dayE },
            status: { $in: ['pending','payment_verified','awaiting_assignment','assigned','pending_reassignment','confirmed','scheduled','on-the-way','arrived','in-progress','ongoing','repair_requested','inspection_scheduled','inspection_in_progress','repair_approved','ready_for_repair','repair_scheduled','repair_in_progress'] },
          }).lean();
          if (conflictBooking) continue;
          const conflictAssign = await Assignment.findOne({
            technicianId: t._id,
            bookingDate: { $gte: dayS, $lte: dayE },
            status: { $in: ['pending_acceptance','accepted','en_route','on_site','in_progress'] },
          }).lean();
          if (!conflictAssign) { newTech = t; break; }
        }

        if (newTech) {
          const acceptanceDeadline = calculateAcceptanceDeadline(booking.bookingDate);
          const newAssignment = new Assignment({
            bookingId: booking._id,
            technicianId: newTech._id,
            customerName: booking.customer?.name || '',
            customerPhone: booking.customer?.phone || '',
            customerEmail: booking.customer?.email || '',
            serviceName: booking.service?.name || '',
            serviceType: booking.serviceType || (booking.serviceModel === "RepairService" ? "repair" : "core"),
            servicePrice: booking.totalPrice || booking.estimatedFee || 0,
            bookingDate: booking.bookingDate,
            startTime: booking.startTime || '',
            endTime: booking.endTime || '',
            address: booking.location?.address || '',
            priority: 'normal',
            slaDeadline: new Date(Date.now() + 2 * 60 * 60 * 1000),
            acceptanceDeadline,
            estimatedFee: booking.totalPrice || booking.estimatedFee || 0,
            status: 'pending_acceptance',
          });
          newAssignment.notes.push({ text: 'Auto-reassigned after previous technician expired', by: null, byName: 'System', createdAt: new Date() });
          await newAssignment.save();

          booking.recordStatusHistory({
            fromStatus: booking.status,
            toStatus: isRepair ? 'inspection_scheduled' : 'assigned',
            changedByModel: 'System',
            changedByName: 'System',
            reason: 'Auto-reassigned after expiry',
          });
          booking.status = isRepair ? 'inspection_scheduled' : 'assigned';
          booking.technicianId = newTech._id;
          booking.assignmentId = newAssignment._id;
          booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
          await booking.save();

          const newTechDoc = await Technician.findById(newTech._id);
          if (newTechDoc) {
            newTechDoc.availabilityStatus = 'Assigned';
            await newTechDoc.save();
          }

          const _io2 = app.get("io") || global._io;
          await createNotification({
            type: 'assignment_new',
            title: 'New Assignment',
            message: `You have been auto-assigned to ${booking.service?.name || 'a service'} after the previous technician did not respond. Please accept before the deadline.`,
            userId: newTech._id,
            role: 'technician',
            referenceId: newAssignment._id,
            referenceModel: 'Assignment',
            link: '/technician/assignments',
            io: _io2,
          });
          if (_io2) _io2.to(`tech:${newTech._id}`).emit('assignment:new', { bookingId: booking._id, bookingReference: booking.bookingReference, serviceName: booking.service?.name });
          reassigned = true;
        }

        if (!reassigned) {
          booking.recordStatusHistory({
            fromStatus: booking.status,
            toStatus: 'pending_reassignment',
            changedByModel: 'System',
            changedByName: 'System',
            reason: 'No response before deadline; no available technician for auto-reassign',
          });
          booking.status = 'pending_reassignment';
          booking.technicianId = null;
          booking.assignmentId = null;
          booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
          booking.cancellationHistory.push({
            technicianId: assignment.technicianId,
            technicianName: 'Technician (response timed out)',
            action: 'auto_reschedule',
            reason: 'No response before acceptance deadline',
            timestamp: now,
          });
          await booking.save();
        }
      }

      const tech = await Technician.findById(assignment.technicianId);
      if (tech) {
        tech.availabilityStatus = "available";
        await tech.save();
      }

      const _io = app.get("io") || global._io;
      await createNotification({
        type: "assignment_expired",
        title: "Assignment Expired",
        message: `Assignment for ${assignment.serviceName || "a service"} expired due to no response before the deadline.`,
        role: "admin",
        referenceId: assignment._id,
        referenceModel: "Assignment",
        link: "/admin/appointments?tab=queue",
        io: _io,
      });
      if (_io) {
        _io.to("admin-room").emit("assignment:expired", {
          assignmentId: assignment._id,
          bookingId: assignment.bookingId,
          reason: "No response before deadline",
        });
      }
      await createNotification({
        type: "assignment_expired",
        title: "Assignment Expired",
        message: `Your assignment for ${assignment.serviceName || "a service"} expired because it was not accepted before the deadline.`,
        userId: assignment.technicianId,
        role: "technician",
        referenceId: assignment._id,
        referenceModel: "Assignment",
        link: "/technician/assignments",
        io: _io,
      });
    }
  } catch (err) {
    console.error("[watchdog] acceptance expiry error:", err.message);
  }
}, 60 * 1000);

databaseReady
  .then(() => {
    startBackgroundSchedulers();
    server.listen(PORT, () => {
      console.log("✓ Server is running");
      console.log(`→ http://localhost:${PORT}`);
    });
  })
  .catch(() => {
    process.exit(1);
  });
