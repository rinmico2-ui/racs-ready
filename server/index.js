const express = require("express");
const logger = require("./utils/logger").create("server");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const path = require("path");
const expressEjsLayouts = require("express-ejs-layouts");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const attachCurrentUser = require("./middleware/currentUser");
const User = require("./models/User");
const AuthSession = require("./models/AuthSession");
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

dotenv.config();

const app = express();

// Database connection
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb://localhost:27017/appointment_scheduler";

logger.info("Connecting to MongoDB:", MONGODB_URI);

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    logger.info("MongoDB connected successfully");
    // Seed default roles (idempotent — only creates roles that don't exist yet)
    try {
      const seedRoles = require("./scripts/seedRoles");
      await seedRoles();
    } catch (e) {
      logger.warn("Role seeding failed: %s", e && e.message);
    }
  })
  .catch((err) => {
    logger.error("MongoDB connection error: %s", err.message);
    process.exit(1);
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
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://www.gstatic.com https://www.recaptcha.net; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://maps.googleapis.com https://maps.gstatic.com; " +
    "img-src 'self' data: https://cdn.jsdelivr.net https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://www.gstatic.com https://www.recaptcha.net https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org https://a.basemaps.cartocdn.com https://b.basemaps.cartocdn.com https://c.basemaps.cartocdn.com https://d.basemaps.cartocdn.com https://api.qrserver.com; " +
    "connect-src 'self' data: https://cdn.jsdelivr.net https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://www.gstatic.com https://www.recaptcha.net https://psgc.cloud https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org https://a.basemaps.cartocdn.com https://b.basemaps.cartocdn.com https://c.basemaps.cartocdn.com https://d.basemaps.cartocdn.com https://nominatim.openstreetmap.org https://api.qrserver.com https://unpkg.com https://router.project-osrm.org ws://localhost:* wss://localhost:*; " +
    "font-src 'self' data: https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
    "frame-src 'self' https://www.google.com https://www.gstatic.com https://www.recaptcha.net;",
  );
  next();
});

app.use(cors());

// request logging middleware (small overhead)
app.use((req, res, next) => {
  const start = process.hrtime();
  res.on("finish", () => {
    const diff = process.hrtime(start);
    const ms = diff[0] * 1e3 + diff[1] / 1e6;
    logger.http(
      "%s %s %d %dms",
      req.method,
      req.url,
      res.statusCode,
      ms.toFixed(1),
    );
  });
  next();
});
// increase payload limit to accommodate base64-encoded proof images
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// express-session (server-side sessions)
const session = require("express-session");
const MongoStore = require("connect-mongo");
const SESSION_TTL = Number(process.env.SESSION_TTL_MS) || 30 * 60 * 1000; // ms
const SESSION_SECRET =
  process.env.SESSION_SECRET || process.env.JWT_SECRET || "dev-session-secret";

// create a named session store so we can clear it in development on startup
const sessionStore = MongoStore.create({
  mongoUrl: MONGODB_URI,
  ttl: Math.floor(SESSION_TTL / 1000),
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

// Development convenience: clear server-side sessions and invalidate JWT-bound sessionIds
// on server start so restarting the dev server doesn't leave you logged in.
if (process.env.NODE_ENV === "development") {
  (async function clearDevSessions() {
    try {
      if (sessionStore && typeof sessionStore.clear === "function") {
        await new Promise((resolve, reject) =>
          sessionStore.clear((err) => (err ? reject(err) : resolve())),
        );
        // dev: express-session store cleared (log suppressed)
      }
    } catch (e) {
      logger.warn(
        "Dev: failed to clear session store on startup: %s",
        e && e.message,
      );
    }

    try {
      await User.updateMany({}, { $unset: { currentSessionId: 1 } });
      await AuthSession.updateMany({}, { $set: { revoked: true } });
      // dev: user session ids invalidated and auth sessions revoked (log suppressed)
    } catch (e) {
      console.warn(
        "Dev: failed to clear user session ids on startup:",
        e && e.message,
      );
    }
  })();
}

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

app.use(express.static(path.join(__dirname, "public")));

// Routes
const pageRoutes = require("./routes/pages");
app.use("/", pageRoutes);

// API routes
const productRoutes = require("./routes/productRoutes");
app.use("/api/products", productRoutes);

const orderRoutes = require("./routes/orderRoutes");
app.use("/api/orders", orderRoutes);

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
app.use("/api/auth", authRoutes);

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

const bookingFlow = require("./routes/bookingFlow");
app.use("/api/booking-flow", bookingFlow);

// Enterprise Appointment Management API
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
app.use("/api/chat", chatRoutes);

// Public holidays (supports multiple providers: google or nager)
const holidayRoutes = require("./routes/holidayRoutes");
app.use("/api/holidays", holidayRoutes);

// PayMongo webhook (public)
const paymongoRoutes = require("./routes/paymongoRoutes");
app.use("/api/paymongo", paymongoRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[DEBUG_ERR] ${err.stack}`);
  res.status(500).json({ error: err.message });
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
startOverdueScheduler();

// ── Overtime Delay Monitor ─────────────────────────────────────────────────
// Periodically scans active jobs that have overrun their buffered capacity end
// and auto-notifies (notify-only) any later same-technician bookings on the
// same day. See server/utils/delayNotifier.js.
const { startDelayMonitor } = require('./utils/delayNotifier');
startDelayMonitor();

server = app.listen(PORT, () => {
  console.log("✓ Server is running");
  console.log(`→ http://localhost:${PORT}`);
});

// ── Socket.io Setup for Live Tracking ────────────────────────────────────────
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  path: "/socket.io",
});

io.on("connection", (socket) => {
  console.log("[socket] client connected:", socket.id);

  // Technician shares location
  socket.on("tech:location", (data) => {
    io.emit("tech:location:update", {
      techId: data.techId,
      name: data.name,
      lat: data.lat,
      lng: data.lng,
      status: data.status,
      timestamp: Date.now(),
    });
  });

  // ── GPS Update from technician tracker ──────────────────────────────────
  // Saves location to DB and broadcasts to the customer room in real-time.
  socket.on("gps:update", async (data) => {
    try {
      const { techId, lat, lng, accuracy, bookingId, customerId } = data;
      if (!techId || typeof lat !== "number" || typeof lng !== "number") return;

      const Technician = require("./models/Technician");
      await Technician.findOneAndUpdate(
        { _id: techId },
        { location: { type: "Point", coordinates: [lng, lat] } },
        { new: true },
      );

      // Broadcast to the specific customer watching this booking
      if (customerId) {
        io.to("customer:" + customerId).emit("gps:location", {
          techId,
          lat,
          lng,
          accuracy,
          bookingId,
          timestamp: Date.now(),
        });
      }

      // Also broadcast to admin room and all tech trackers
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
    io.to("tech:" + data.techId).emit("assignment:new", data);
  });

  // Technician joins their room for targeted notifications
  socket.on("tech:join", (techId) => {
    // Handle both string and object formats
    const id = typeof techId === 'object' ? (techId.techId || techId.id || '') : techId;
    if (id) {
      socket.join("tech:" + id);
      console.log("[socket] technician joined room:", id);
    }
  });

  // Customer joins their room for targeted tracking updates
  socket.on("customer:join", (customerId) => {
    socket.join("customer:" + customerId);
    console.log("[socket] customer joined room:", customerId);
  });

  // Admin/secretary joins admin room for notifications
  socket.on("admin:join", (userId) => {
    socket.join("admin-room");
    socket.join("user:" + userId);
    console.log("[socket] admin joined room:", userId);
  });

  // Technician joins their user room for personal notifications
  socket.on("tech:user-join", (userId) => {
    socket.join("user:" + userId);
    console.log("[socket] technician joined user room:", userId);
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
        const candidates = await Technician.find({
          _id: { $ne: assignment.technicianId },
          active: true,
          availabilityStatus: "Available",
        }).lean();

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
          booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
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
        link: "/admin/appointments?tab=waiting-reassign",
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
