const express = require("express");
const router = express.Router();

const defaultTechnicianLocation = {
  lat: 14.676049,
  lng: 121.043731,
};

const auth = require("../middleware/authenticate");
const pageAuth = require("../middleware/pageAuth");

let farePerKm = 40;

function generateMathCaptcha() {
  const num1 = Math.floor(Math.random() * 90) + 10; // 10-99 (double digit)
  const num2 = Math.floor(Math.random() * 9) + 1;   // 1-9 (single digit)
  const answer = num1 + num2;
  return { num1, num2, answer };
}

// lightweight endpoint that returns a fresh math captcha.
// used by client-side scripts so the user can reload the captcha without
// reloading the whole auth page.
router.get("/math-captcha", (req, res) => {
  const { num1, num2, answer } = generateMathCaptcha();
  res.json({ num1, num2, answer });
});

// Landing page
router.get("/", pageAuth.requireCustomerOrGuest, async (req, res) => {
  let featuredProducts = [];
  try {
    const HVACProduct = require("../models/HVACProduct");
    const products = await HVACProduct.find({
      active: true,
      salesChannel: { $in: ["web", "both"] },
      status: { $ne: "discontinued" },
    })
      .populate("category", "name")
      .populate("brand", "name")
      .sort({ modelLine: 1 })
      .limit(8)
      .lean();

    featuredProducts = products.map((item) => {
      const variants = (item.variants || []).filter((v) => v.active);
      const prices = variants.map((v) => v.sellingPrice).filter((p) => p > 0);
      const totalStock = variants.reduce((s, v) => s + (v.quantity || 0), 0);
      const firstInStock = variants.find(
        (v) => v.status === "in_stock" && v.quantity > 0
      );
      const anyStock = variants.some((v) => v.quantity > 0);
      return {
        _id: item._id,
        modelLine: item.modelLine,
        brand: item.brand ? item.brand.name : "",
        category: item.category ? item.category.name : "",
        type: item.type || "split",
        inverter: item.inverter || false,
        imageUrl: item.imageUrl || "/images/products/default.png",
        description: item.description || "",
        features:
          item.specifications && item.specifications.features
            ? item.specifications.features
            : [],
        warranty:
          item.specifications && item.specifications.warranty
            ? item.specifications.warranty
            : "1 Year Compressor, 1 Year Parts",
        startingPrice: prices.length ? Math.min(...prices) : 0,
        totalStock,
        inStock: anyStock,
        firstCapacity: firstInStock ? firstInStock.capacity : (variants[0] && variants[0].capacity) || "",
      };
    });
  } catch (err) {
    // Don't block the landing page if the catalog is unavailable.
    console.error("Landing page failed to load products:", err && err.message);
  }

  // ── Fetch rating stats & testimonials ────────────────────────────
  let avgRating = null;
  let ratingCount = 0;
  let testimonials = [];
  try {
    const Rating = require("../models/Rating");
    const stats = await Rating.aggregate([
      { $group: { _id: null, avgScore: { $avg: "$score" }, count: { $sum: 1 } } },
    ]);
    if (stats.length) {
      avgRating = Math.round(stats[0].avgScore * 10) / 10;
      ratingCount = stats[0].count;
    }

    const recent = await Rating.find({ comment: { $exists: true, $ne: "" } })
      .populate("customerId", "firstName lastName")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    testimonials = recent
      .filter((r) => r.comment && r.comment.trim().length > 15)
      .map((r) => ({
        quote: r.comment.trim(),
        name: r.customerId
          ? [r.customerId.firstName, r.customerId.lastName].filter(Boolean).join(" ")
          : "Customer",
        role: "Verified Customer",
        score: r.score,
      }));
  } catch (err) {
    console.error("Landing page failed to load ratings:", err && err.message);
  }

  const displayRating = avgRating || 4.9;
  const displayCount = ratingCount || 3;

  res.render("pages/landing", {
    title: "CALIDRO RACS",
    featuredProducts,
    avgRating,
    ratingCount,
    testimonials,
    displayRating,
    displayCount,
  });
});

// Services page
// when rendering the booking UI we can also preload the service catalog so that
// the client has something to show immediately (and the page is usable without JS).
// This also ensures we're pulling from the CoreService/RepairService collections
// instead of the legacy `Service` model.

const CoreService = require("../models/CoreService");
const RepairService = require("../models/RepairService");

router.get("/services", pageAuth.requireCustomerOrGuest, async (req, res) => {
  let initialServices = { coreServices: [], repairs: [] };
  try {
    const core = await CoreService.find({ active: true }).lean().limit(100);
    const repairs = await RepairService.find({ active: true })
      .lean()
      .limit(100);
    initialServices = { coreServices: core, repairs };
  } catch (err) {
    // log but don't block rendering; client will still fetch via API later
    console.error(
      "/services page failed to preload services:",
      err && err.message,
    );
  }

  // load the admin-configured fare per km (falls back to 40 if not set)
  try {
    const SiteSetting = require("../models/SiteSetting");
    const setting = await SiteSetting.findOne({ key: "farePerKm" }).lean();
    if (setting && typeof setting.value === "number") farePerKm = setting.value;
  } catch (e) { /* ignore — fallback already set */ }

  // load the admin-configured project labor rate per day (falls back to 0 if not set)
  let projectLaborRatePerDay = 0;
  try {
    const SiteSetting = require("../models/SiteSetting");
    const setting = await SiteSetting.findOne({ key: "projectLaborRatePerDay" }).lean();
    if (setting && typeof setting.value === "number") projectLaborRatePerDay = setting.value;
  } catch (e) { /* ignore — fallback already set */ }

  res.render("pages/services", {
    title: "Core Service",
    googleCalendarClientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || "",
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
    technicianLocation: defaultTechnicianLocation,
    initialServices,
    // supply the admin's GCash number for the QR code
    adminGcashNumber: process.env.ADMIN_GCASH_NUMBER || "",
    farePerKm,
    projectLaborRatePerDay,
  });
});

// Repair Request page (enterprise work order flow)
router.get("/repair-request", pageAuth.requireCustomerOrGuest, async (req, res) => {
  // load the admin-configured fare per km (falls back to 40 if not set)
  try {
    const SiteSetting = require("../models/SiteSetting");
    const setting = await SiteSetting.findOne({ key: "farePerKm" }).lean();
    if (setting && typeof setting.value === "number") farePerKm = setting.value;
  } catch (e) { /* ignore — fallback already set */ }

  res.render("pages/repair-request", {
    title: "Repair Service",
    adminGcashNumber: process.env.ADMIN_GCASH_NUMBER || "",
    farePerKm,
    technicianLocation: defaultTechnicianLocation,
  });
});

// Products page
router.get("/products", pageAuth.requireCustomerOrGuest, async (req, res, next) => {
  try {
    const HVACProduct = require("../models/HVACProduct");
    // fetch active HVAC items that are sellable on the web
    const products = await HVACProduct.find({
      active: true,
      salesChannel: { $in: ["web", "both"] },
      status: { $ne: "discontinued" },
    })
      .populate("category", "name")
      .populate("brand", "name")
      .sort({ modelLine: 1 })
      .lean();

    const grouped = products.map((item) => {
      const g = {
        _id: item._id,
        modelLine: item.modelLine,
        brand: item.brand ? item.brand.name : "",
        category: item.category ? item.category.name : "",
        type: item.type || "split",
        inverter: item.inverter || false,
        imageUrl: item.imageUrl || "/images/products/default.png",
        description: item.description || "",
        features: (item.specifications && item.specifications.features) ? item.specifications.features : [],
        warranty: (item.specifications && item.specifications.warranty) ? item.specifications.warranty : "",
        voltage: (item.specifications && item.specifications.voltage) ? item.specifications.voltage : "220-240V / 60Hz",
        installationRequirements: (item.specifications && item.specifications.installationRequirements) ? item.specifications.installationRequirements : "",
        specifications: item.specifications || {},
        rating: item.rating || 0,
        ratingCount: item.ratingCount || 0,
        variants: (item.variants || []).filter(v => v.active).map(v => ({
          _id: v._id,
          capacity: v.capacity,
          capacityUnit: v.capacityUnit || "HP",
          btu: v.btu || 0,
          sellingPrice: v.sellingPrice || 0,
          quantity: v.quantity || 0,
          status: v.status || "out_of_stock",
          sku: v.sku || "",
          specifications: v.specifications || {},
        })).sort((a, b) => parseFloat(a.capacity) - parseFloat(b.capacity))
      };
      
      const prices = g.variants.map((v) => v.sellingPrice).filter((p) => p > 0);
      const totalStock = g.variants.reduce((s, v) => s + (v.quantity || 0), 0);
      
      return { 
        ...g, 
        startingPrice: prices.length ? Math.min(...prices) : 0, 
        totalStock, 
        inStock: totalStock > 0 
      };
    });

    res.render("pages/product", {
      title: "Products",
      products,
      grouped,
      adminGcashNumber: process.env.ADMIN_GCASH_NUMBER || ''
    });
  } catch (err) {
    next(err);
  }
});

// Product detail page
router.get("/products/:id", pageAuth.requireCustomerOrGuest, async (req, res, next) => {
  try {
    const HVACProduct = require("../models/HVACProduct");
    const product = await HVACProduct.findById(req.params.id)
      .populate("category", "name")
      .populate("brand", "name")
      .lean();

    if (!product || !product.active) {
      return res.status(404).render("pages/404", { title: "Product Not Found" });
    }

    const variants = (product.variants || []).filter(v => v.active).map(v => ({
      _id: v._id,
      capacity: v.capacity,
      capacityUnit: v.capacityUnit || "HP",
      btu: v.btu || 0,
      sellingPrice: v.sellingPrice || 0,
      quantity: v.quantity || 0,
      status: v.status || "out_of_stock",
      sku: v.sku || "",
      specifications: v.specifications || {},
    })).sort((a, b) => parseFloat(a.capacity) - parseFloat(b.capacity));

    const prices = variants.map(v => v.sellingPrice).filter(p => p > 0);
    const startingPrice = prices.length ? Math.min(...prices) : 0;
    const totalStock = variants.reduce((s, v) => s + (v.quantity || 0), 0);

    // Fetch featured products for "related" section
    const featured = await HVACProduct.find({
      _id: { $ne: product._id },
      active: true,
      salesChannel: { $in: ["web", "both"] },
      status: { $ne: "discontinued" },
    })
      .populate("brand", "name")
      .limit(4)
      .sort({ rating: -1 })
      .lean();

    const related = featured.map(item => ({
      _id: item._id,
      modelLine: item.modelLine,
      brand: item.brand?.name || "",
      type: item.type || "split",
      inverter: item.inverter || false,
      imageUrl: item.imageUrl || "/images/products/default.png",
      startingPrice: Math.min(...(item.variants || []).filter(v => v.active).map(v => v.sellingPrice || 0).filter(p => p > 0)) || 0,
      totalStock: (item.variants || []).reduce((s, v) => s + (v.quantity || 0), 0),
    }));

    // Fetch cart data for checkout wizard
    let cartData = { items: [], totalAmount: 0 };
    if (req.user) {
      try {
        const AirconCart = require("../models/AirconCart");
        const Inventory = require("../models/Inventory");
        const Brand = require("../models/Brand");
        const HVACProduct = require("../models/HVACProduct");
        const cart = await AirconCart.findOne({ userId: req.user._id }).lean();
        if (cart) {
          let totalAmount = 0;
          for (let i = cart.items.length - 1; i >= 0; i--) {
            const item = cart.items[i];
            const id = item.inventoryId;
            let inv = await Inventory.findById(id).lean();
            if (inv) {
              if (inv.brand) inv.brand = await Brand.findById(inv.brand).select("name").lean();
              item.inventoryId = inv;
              totalAmount += (inv.sellingPrice || 0) * (item.quantity || 1);
            } else {
              const hvacDoc = await HVACProduct.findOne({ "variants._id": id }).populate("brand", "name").lean();
              if (hvacDoc) {
                const variant = hvacDoc.variants.find(v => v._id.toString() === id.toString());
                item.inventoryId = {
                  _id: variant._id,
                  modelLine: hvacDoc.modelLine,
                  brand: hvacDoc.brand,
                  capacity: variant.capacity,
                  capacityUnit: variant.capacityUnit,
                  sellingPrice: variant.sellingPrice,
                  imageUrl: hvacDoc.imageUrl,
                  inverter: hvacDoc.inverter
                };
                totalAmount += (variant.sellingPrice || 0) * (item.quantity || 1);
              } else {
                cart.items.splice(i, 1);
              }
            }
          }
          cartData = { items: cart.items, totalAmount };
        }
      } catch (_) {}
    }

    res.render("pages/product-detail", {
      title: product.modelLine,
      product: {
        _id: product._id,
        modelLine: product.modelLine,
        brand: product.brand?.name || "",
        category: product.category?.name || "",
        type: product.type || "split",
        inverter: product.inverter || false,
        imageUrl: product.imageUrl || "/images/products/default.png",
        description: product.description || "",
        features: (product.specifications?.features) || [],
        warranty: product.specifications?.warranty || "",
        voltage: product.specifications?.voltage || "220-240V / 60Hz",
        installationRequirements: product.specifications?.installationRequirements || "",
        specifications: product.specifications || {},
        rating: product.rating || 0,
        ratingCount: product.ratingCount || 0,
        variants,
        startingPrice,
        totalStock,
        inStock: totalStock > 0,
      },
      related,
      cartData,
      adminGcashNumber: process.env.ADMIN_GCASH_NUMBER || '',
    });
  } catch (err) {
    next(err);
  }
});

// My Orders (customer order tracking)
router.get("/my-orders", pageAuth.requireRole("customer"), async (req, res, next) => {
  try {
    const Order = require("../models/Order");
    const orders = await Order.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
    res.render("pages/my-orders", { title: "My Orders", orders });
  } catch (err) {
    next(err);
  }
});

// Aircon Cart (persistent shopping cart)
router.get("/aircon-cart", pageAuth.requireRole("customer"), async (req, res, next) => {
  try {
    const AirconCart = require("../models/AirconCart");
    let cart = await AirconCart.findOne({ userId: req.user._id }).lean();
    if (!cart) {
      cart = { userId: req.user._id, items: [] };
    } else {
      const HVACProduct = require("../models/HVACProduct");
      const Inventory = require("../models/Inventory");
      const Brand = require("../models/Brand");

      let totalAmount = 0;
      for (let i = cart.items.length - 1; i >= 0; i--) {
        const item = cart.items[i];
        const id = item.inventoryId;
        
        let inv = await Inventory.findById(id).lean();
        if (inv) {
          if (inv.brand) inv.brand = await Brand.findById(inv.brand).select("name").lean();
          item.inventoryId = inv;
          totalAmount += (inv.sellingPrice || 0) * (item.quantity || 1);
        } else {
          const hvacDoc = await HVACProduct.findOne({ "variants._id": id }).populate("brand", "name").lean();
          if (hvacDoc) {
            const variant = hvacDoc.variants.find(v => v._id.toString() === id.toString());
            item.inventoryId = {
              _id: variant._id,
              modelLine: hvacDoc.modelLine,
              brand: hvacDoc.brand,
              capacity: variant.capacity,
              capacityUnit: variant.capacityUnit,
              sellingPrice: variant.sellingPrice,
              imageUrl: hvacDoc.imageUrl,
              inverter: hvacDoc.inverter
            };
            totalAmount += (variant.sellingPrice || 0) * (item.quantity || 1);
          } else {
            // item no longer exists
            cart.items.splice(i, 1);
          }
        }
      }
      cart.totalAmount = totalAmount;
    }
    res.render("pages/aircon-cart", {
      title: "Aircon Cart",
      cart,
      adminGcashNumber: process.env.ADMIN_GCASH_NUMBER || "",
    });
  } catch (err) {
    next(err);
  }
});

// Aircon Order History (subset of my-orders focusing on aircons)
router.get("/aircon-history", pageAuth.requireRole("customer"), async (req, res, next) => {
  try {
    const Order = require("../models/Order");
    const orders = await Order.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
    res.render("pages/aircon-history", { title: "Aircon Order History", orders });
  } catch (err) {
    next(err);
  }
});

// About page
router.get("/about", pageAuth.requireCustomerOrGuest, (req, res) => {
  res.render("pages/about", { title: "About Us" });
});

// Contact page
router.get("/contact", pageAuth.requireCustomerOrGuest, (req, res) => {
  res.render("pages/contact", { title: "Contact Us" });
});

// Login page
const crypto = require("crypto");
const SiteSetting = require("../models/SiteSetting");
async function getCompanyAddress() {
  try {
    const s = await SiteSetting.findOne({ key: "companyLocationAddress" }).lean();
    return s?.value || "Quezon City";
  } catch { return "Quezon City"; }
}

async function getCompanyLocation() {
  try {
    const [lat, lng, addr] = await Promise.all([
      SiteSetting.findOne({ key: "companyLocationLat" }).lean(),
      SiteSetting.findOne({ key: "companyLocationLng" }).lean(),
      SiteSetting.findOne({ key: "companyLocationAddress" }).lean(),
    ]);
    const latVal = lat && lat.value != null ? parseFloat(lat.value) : NaN;
    const lngVal = lng && lng.value != null ? parseFloat(lng.value) : NaN;
    if (Number.isFinite(latVal) && Number.isFinite(lngVal)) {
      return { lat: latVal, lng: lngVal, address: addr?.value || "Company Office" };
    }
  } catch { /* ignore */ }
  return { lat: 14.676049, lng: 121.043731, address: "Quezon City" };
}
router.get("/login", async (req, res) => {
  const csrfToken = crypto.randomBytes(24).toString("hex");
  const isProd = process.env.NODE_ENV === "production";
  const { num1, num2, answer } = generateMathCaptcha();
  res.cookie("XSRF-TOKEN", csrfToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: "Strict",
    path: "/",
  });
  res.render("pages/auth", {
    title: "Authentication",
    csrfToken,
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || "",
    error: null,
    registered: req.query.registered || null,
    layout: "layouts/auth",
    num1,
    num2,
    mathAnswer: answer,
    active: "sign-in",
    returnTo: req.query.returnTo || null,
    companyAddress: await getCompanyAddress(),
    extraScripts: [
      "/js/auth-panel.js",
      "/js/login.js",
      "/js/register.js",
      "/js/psgc-handler.js",
    ],
  });
});

// Register page (customers only) -> render combined auth panel, prefer sign-up
router.get("/register", async (req, res) => {
  const csrfToken = crypto.randomBytes(24).toString("hex");
  const isProd = process.env.NODE_ENV === "production";
  const { num1, num2, answer } = generateMathCaptcha();
  res.cookie("XSRF-TOKEN", csrfToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: "Strict",
    path: "/",
  });
  res.render("pages/auth", {
    title: "Create an Account",
    csrfToken,
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || "",
    layout: "layouts/auth",
    num1,
    num2,
    mathAnswer: answer,
    active: "sign-up",
    companyAddress: await getCompanyAddress(),
    extraScripts: [
      "/js/auth-panel.js",
      "/js/login.js",
      "/js/register.js",
      "/js/psgc-handler.js",
    ],
  });
});

// Forgot password page
router.get("/forgot-password", (req, res) => {
  const csrfToken = crypto.randomBytes(24).toString("hex");
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("XSRF-TOKEN", csrfToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: "Strict",
    path: "/",
  });
  const { num1, num2, answer } = generateMathCaptcha();
  res.render("pages/forgot-password", {
    title: "Forgot your password",
    csrfToken,
    layout: "layouts/auth",
    extraScripts: ["/js/forgot.js"],
    num1,
    num2,
    mathAnswer: answer,
    recaptchaSiteKey: "",
  });
});

// Reset password (token in query)
router.get("/reset-password", (req, res) => {
  const csrfToken = crypto.randomBytes(24).toString("hex");
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("XSRF-TOKEN", csrfToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: "Strict",
    path: "/",
  });
  const { num1, num2, answer } = generateMathCaptcha();
  res.render("pages/reset-password", {
    title: "Reset your password",
    csrfToken,
    token: req.query.token || "",
    layout: "layouts/auth",
    extraScripts: ["/js/reset.js"],
    num1,
    num2,
    mathAnswer: answer,
    // no reCAPTCHA on reset page
    recaptchaSiteKey: "",
  });
});

// Access denied
router.get("/access-denied", (req, res) => {
  res.status(403).render("pages/access-denied", { title: "Access Denied" });
});

// Profile (authenticated users)
router.get("/profile", pageAuth.requireRole("customer"), async (req, res, next) => {
  // If an admin visits the generic profile route, forward them to the admin profile page
  if (req.user && req.user.role === "admin") return res.redirect("/profile-admin");
  // likewise, secretary users should see their specialized profile
  if (req.user && req.user.role === "secretary") return res.redirect("/secretary/profile");

  try {
    const Rating = require("../models/Rating");
    const Inventory = require("../models/Inventory");
    const Technician = require("../models/Technician");

    const ratings = await Rating.find({ customerId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    // add targetName for display
    for (const r of ratings) {
      if (r.targetType === "inventory") {
        const item = await Inventory.findById(r.targetId).select("itemName").lean();
        r.targetName = item ? item.itemName : "(deleted)";
      } else if (r.targetType === "technician") {
        const tech = await Technician.findById(r.targetId).select("name").lean();
        r.targetName = tech ? tech.name : "(deleted)";
      } else if (r.targetType === "booking") {
        r.targetName = String(r.targetId);
      }
    }

    // also load purchases and completed bookings so user can rate them
    const Purchase = require("../models/Purchase");
    const BookingService = require("../models/BookingService");
    const purchases = await Purchase.find({ userId: req.user._id })
      .sort({ purchaseDate: -1 })
      .lean();
    const bookings = await BookingService.find({ customerId: req.user._id, status: "completed" })
      .sort({ bookingDate: -1 })
      .lean();

    // build product item list from purchases, avoid duplicates
    const productItems = [];
    const seen = new Set();
    purchases.forEach((p) => {
      (p.items || []).forEach((it) => {
        const key = it.productId ? String(it.productId) : it.name;
        if (!seen.has(key)) {
          seen.add(key);
          productItems.push({
            productId: it.productId || null,
            name: it.name,
          });
        }
      });
    });

    res.render("pages/profile", {
      title: "My Profile",
      user: req.user,
      ratings,
      productItems,
      bookings,
    });
  } catch (err) {
    next(err);
  }
});

// User -> reuse profile view (shows login prompt when not authenticated)
router.get("/user", (req, res) => {
  // prevent caching so back/forward can't resurrect an authenticated view
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.render("pages/profile", { title: "My Profile" });
});

// Admin-only profile (separate view)
router.get("/profile-admin", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/profile-admin", {
    title: "Admin Profile",
    layout: "layouts/admin",
  });
});

// Backwards-compatible admin path
router.get("/admin/profile", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/profile-admin", {
    title: "Admin Profile",
    layout: "layouts/admin",
  });
});

// Book History (customers only)
router.get("/book-history", pageAuth.requireRole("customer"), (req, res) => {
  res.render("pages/book-history", { title: "Booking History" });
});

// Live Tracking (customers only)
router.get("/tracking", pageAuth.requireRole("customer"), async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const items = await BookingService.find({
      customerId: req.user._id,
      status: {
        $in: [
          "pending",
          "confirmed",
          "scheduled",
          "on-the-way",
          "arrived",
          "in-progress",
          "completed",
          "re-scheduled",
          "expired",
        ],
      },
    })
      .populate("technicianId", "name phone profileImage rating")
      .populate("customerId", "name phone")
      .sort({ bookingDate: 1, startTime: 1 })
      .limit(100)
      .lean();

    // Normalize technician object so client helpers work uniformly regardless of population
    items.forEach((b) => {
      if (b.technicianId && typeof b.technicianId === "object") {
        b.technicianName = b.technicianId.name || b.technicianName;
        b.technicianPhone = b.technicianId.phone || "";
      }
      if (b.customerId && typeof b.customerId === "object") {
        b.customerName = b.customerId.name || b.customerName;
        b.customerPhone = b.customerId.phone || "";
      }
    });

    const current =
      items.find(
        (b) =>
          String(b.status || "").toLowerCase() === "confirmed" &&
          b.bookingDate &&
          new Date(b.bookingDate) >= today,
      ) || items[0] || null;

    res.render("pages/tracking", {
      title: "Live Tracking",
      initialBookings: items,
      initialBooking: current,
    });
  } catch (e) {
    next(e);
  }
});

// ── PayMongo GCash redirect landing pages ────────────────────────────────────
// PayMongo redirects the customer here after GCash payment completes or fails.
router.get("/payment/success", pageAuth.requireCustomerOrGuest, (req, res) => {
  const { ref, method } = req.query;
  res.render("pages/payment-success", {
    title:         "Payment Successful",
    bookingRef:    ref   || "",
    paymentMethod: method || "gcash",
    layout:        "main",
  });
});

router.get("/payment/failed", pageAuth.requireCustomerOrGuest, (req, res) => {
  const { ref, method } = req.query;
  res.render("pages/payment-failed", {
    title:         "Payment Failed",
    bookingRef:    ref   || "",
    paymentMethod: method || "gcash",
    layout:        "main",
  });
});

// Payment processing page
router.get("/payment", pageAuth.requireCustomerOrGuest, (req, res) => {
  const { bookingId, method, amount, ref, service } = req.query;
  
  // Validate required parameters
  if (!bookingId || !method || !amount) {
    return res.status(400).send(`
      <html>
        <head><title>Payment Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>Payment Error</h2>
          <p>Missing required payment information</p>
          <a href="/services">Return to Services</a>
        </body>
      </html>
    `);
  }
  
  res.render("pages/payment", {
    title: "Process Payment",
    paymentData: {
      bookingId,
      paymentMethod: method, // Changed from 'method' to 'paymentMethod'
      amount: parseFloat(amount),
      bookingRef: ref,
      serviceName: service
    }
  });
});

// Purchase History (customers only)
router.get(
  "/purchase-history",
  pageAuth.requireRole("customer"),
  async (req, res, next) => {
    try {
      const Order = require("../models/Order");
      const orders = await Order.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .lean();
      res.render("pages/purchase-history", { title: "Purchase History", orders });
    } catch (err) {
      next(err);
    }
  },
);

// Secretary profile (role-specific page) -- similar look/feel to admin profile
router.get(
  "/secretary/profile",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/secretary-profile", {
      title: "Secretary Profile",
      layout: "layouts/secretary",
    });
  },
);

// Technician profile (role-specific page) – reuse profile-technician view
router.get(
  "/technician/profile",
  pageAuth.requireRole("technician"),
  async (req, res) => {
    try {
      const Technician = require("../models/Technician");
      const techProfile = await Technician.findOne({ user: req.user._id }).lean();
      res.render("pages/technician/profile-technician", {
        title: "Technician Profile",
        layout: "layouts/technician",
        techProfile: techProfile
      });
    } catch (err) {
      console.error(err);
      res.redirect("/technician");
    }
  },
);

// Catch /secretary/settings to avoid 404 (secretary doesn't have separate settings page)
router.get(
  "/secretary/settings",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.redirect("/secretary/profile");
  },
);

// Admin dashboard
router.get("/admin", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/admin-dashboard", {
    title: "Admin Dashboard",
    layout: "layouts/admin",
  });
});

// Admin - Appointments (unified page)
router.get(
  "/admin/appointments",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Appointments/AppointmentsUnified", {
      title: "Appointment Management",
      layout: "layouts/admin",
    });
  },
);

// Admin - Appointments Completed (redirect to unified page with completed tab)
router.get(
  "/admin/appointments/completed",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.redirect("/admin/appointments?tab=completed");
  },
);

// Admin - Appointments sub-routes redirect to unified page with tab param
router.get(
  "/admin/appointments/overview",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.redirect("/admin/appointments?tab=overview");
  },
);

// Admin - Appointments Calendar
router.get(
  "/admin/appointments/calendar",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Appointments/Calendar", {
      title: "Appointments Calendar",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/appointments/booking-requests",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Appointments/BookingRequest", {
      title: "Booking Requests",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/appointments/reschedule",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Appointments/Reschedule", {
      title: "Reschedule Appointment",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/appointments/walk-in",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Appointments/WalkIn", {
      title: "Walk-in Appointment",
      layout: "layouts/admin",
    });
  },
);

// Admin - Assignment Queue → unified page
router.get(
  "/admin/appointments/queue",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.redirect("/admin/appointments?tab=queue");
  },
);

// Admin - Pending Review → unified page
router.get(
  "/admin/appointments/pending",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.redirect("/admin/appointments?tab=pending");
  },
);

// Admin - Active Jobs → unified page
router.get(
  "/admin/appointments/active",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.redirect("/admin/appointments?tab=active");
  },
);

// Admin - Waiting for Reassignment → unified page with reassignment tab
router.get(
  "/admin/appointments/waiting-reassign",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.redirect("/admin/appointments?tab=waiting");
  },
);

// Admin - Repair Scheduling Queue (Schedule Repair Later)
router.get(
  "/admin/appointments/repair-scheduling",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Appointments/RepairSchedulingQueue", {
      title: "Repair Scheduling Queue",
      layout: "layouts/admin",
    });
  },
);

// Admin - Appointment Management: Cancellation Log
router.get(
  "/admin/appointments/cancellation-log",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Appointments/CancellationLog", {
      title: "Cancellation Log",
      layout: "layouts/admin",
    });
  },
);

// Admin - Appointment Management: Expense Approval
router.get(
  "/admin/appointments/expenses",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Appointments/ExpenseApproval", {
      title: "Expense Approval",
      layout: "layouts/admin",
    });
  },
);

// Admin - Jobs (redirect to Appointment Management)
router.get("/admin/jobs/active", pageAuth.requireRole("admin"), (req, res) => {
  res.redirect("/admin/appointments/active");
});
router.get("/admin/jobs/completed", pageAuth.requireRole("admin"), (req, res) => {
  res.redirect("/admin/appointments?tab=completed");
});

// Admin - Inventory
router.get("/admin/inventory", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/Inventory/InventoryList", {
    title: "Inventory",
    layout: "layouts/admin",
  });
});
router.get(
  "/admin/inventory/repair-parts",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Inventory/RepairParts", {
      title: "Parts & Tools Catalog",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/inventory/pos",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Inventory/POS", {
      title: "Point of Sale",
      layout: "layouts/admin",
      user: req.user,
    });
  },
);
router.get(
  "/admin/inventory/list",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Inventory/InventoryList", {
      title: "Inventory List",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/inventory/history",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Inventory/StockHistory", {
      title: "Stock History",
      layout: "layouts/admin",
    });
  },
);
// Ordered products page — redirect to the new Aircon Orders management page
router.get(
  "/admin/inventory/ordered-products",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.redirect("/admin/appointments/orders");
  },
);

// Aircon Orders — moved to Appointments section
router.get(
  "/admin/inventory/aircon-orders",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.redirect("/admin/appointments/orders");
  },
);

// Delivery Calendar — redirect to unified Appointments Calendar
router.get(
  "/admin/inventory/deliveries",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.redirect("/admin/appointments/calendar");
  },
);

// Orders page under Appointments
router.get(
  "/admin/appointments/orders",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Inventory/AirconOrders", {
      title: "Orders",
      layout: "layouts/admin",
    });
  },
);
// Waiting for Acceptance page
router.get(
  "/admin/appointments/waiting-acceptance",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Appointments/WaitingAcceptance", {
      title: "Waiting for Acceptance",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/tool-usage",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/shared/ToolUsageManagement", {
      title: "Tool Usage Management",
      layout: "layouts/admin",
      apiBase: "/api/admin",
      roleLabel: "admin",
    });
  },
);

// Admin - Customers
router.get(
  "/admin/customers/list",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Customers/CustomerList", {
      title: "Customer List",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/customers/privileges",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Customers/Privilege", {
      title: "Customer Privileges",
      layout: "layouts/admin",
    });
  },
);

// Admin - Staff
router.get("/admin/staff/list", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/Staff/StaffList", {
    title: "Staff List",
    layout: "layouts/admin",
  });
});

// Admin - Payments (redirect to Appointment Management)
router.get("/admin/payments", pageAuth.requireRole("admin"), (req, res) => {
  res.redirect("/admin/appointments/pending");
});
router.get("/admin/payments/pending", pageAuth.requireRole("admin"), (req, res) => {
  res.redirect("/admin/appointments/pending");
});
router.get("/admin/payments/completed", pageAuth.requireRole("admin"), (req, res) => {
  res.redirect("/admin/appointments?tab=completed");
});

// Admin - Services (scaffolded placeholders)
router.get(
  "/admin/services/core",
  pageAuth.requireRole("admin"),
  async (req, res) => {
    try {
      const coreServices = await CoreService.find({}).lean().limit(200);
      // optionally count bookings per service for dashboard stats
      const BookingService = require("../models/BookingService");
      const counts = await BookingService.aggregate([
        { $match: { serviceId: { $in: coreServices.map((s) => s._id) } } },
        { $group: { _id: "$serviceId", count: { $sum: 1 } } },
      ]);
      const countMap = counts.reduce((m, c) => {
        m[c._id.toString()] = c.count;
        return m;
      }, {});
      coreServices.forEach((s) => {
        s.bookingCount = countMap[s._id.toString()] || 0;
      });

      res.render("pages/admin/Services/CoreServices", {
        title: "Core Services",
        layout: "layouts/admin",
        coreServices,
      });
    } catch (err) {
      console.error("/admin/services/core failed", err && err.message);
      res.render("pages/admin/Services/CoreServices", {
        title: "Core Services",
        layout: "layouts/admin",
        coreServices: [],
      });
    }
  },
);
router.get(
  "/admin/services/repair",
  pageAuth.requireRole("admin"),
  async (req, res) => {
    try {
      const repairServices = await RepairService.find({}).lean().limit(200);
      // count bookings for repair services as well
      const BookingService = require("../models/BookingService");
      const counts = await BookingService.aggregate([
        { $match: { serviceId: { $in: repairServices.map((s) => s._id) } } },
        { $group: { _id: "$serviceId", count: { $sum: 1 } } },
      ]);
      const countMap = counts.reduce((m, c) => {
        m[c._id.toString()] = c.count;
        return m;
      }, {});
      repairServices.forEach((s) => {
        s.bookingCount = countMap[s._id.toString()] || 0;
      });

      res.render("pages/admin/Services/RepairServices", {
        title: "Repair Services",
        layout: "layouts/admin",
        repairServices,
      });
    } catch (err) {
      console.error("/admin/services/repair failed", err && err.message);
      res.render("pages/admin/Services/RepairServices", {
        title: "Repair Services",
        layout: "layouts/admin",
        repairServices: [],
      });
    }
  },
);

// Admin - Technicians (scaffolded placeholders)
router.get("/admin/technicians", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/Technicians/TechnicianList", {
    title: "Technicians",
    layout: "layouts/admin",
  });
});

// Admin - Ratings Management
router.get("/admin/ratings/overview", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/Ratings/overview", {
    title: "Rating Overview",
    layout: "layouts/admin",
  });
});

router.get("/admin/ratings/service", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/Ratings/service", {
    title: "Service Ratings",
    layout: "layouts/admin",
  });
});

router.get("/admin/ratings/aircons", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/Ratings/aircons", {
    title: "Aircon Ratings",
    layout: "layouts/admin",
  });
});

router.get("/admin/ratings/technicians", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/Ratings/technicians", {
    title: "Technician Ratings",
    layout: "layouts/admin",
  });
});

router.get("/admin/ratings/analytics", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/Ratings/analytics", {
    title: "Rating Analytics",
    layout: "layouts/admin",
  });
});

// technician pages
// dashboard entry point
router.get(
  "/technician",
  pageAuth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const Technician = require("../models/Technician");
      const BookingService = require("../models/BookingService");
      const tech = await Technician.findOne({ user: req.user._id }).lean();

      let appointments = [];
      if (tech && tech._id) {
        const technicianIds = [String(tech._id)];
        if (tech.user) technicianIds.push(String(tech.user));
        if (req.user && req.user._id) technicianIds.push(String(req.user._id));

        const since = new Date();
        since.setDate(since.getDate() - 1);
        since.setHours(0, 0, 0, 0);

        appointments = await BookingService.find({
          technicianId: { $in: Array.from(new Set(technicianIds)) },
          bookingDate: { $gte: since },
          status: {
            $in: [
              "pending",
              "confirmed",
              "scheduled",
              "on-the-way",
              "in-progress",
              "re-scheduled",
            ],
          },
        })
          .sort({ bookingDate: 1, startTime: 1 })
          .limit(120)
          .lean();
      }
      // Also fetch product order delivery/installation tasks
      let productOrders = [];
      if (tech && tech._id) {
        const Order = require("../models/Order");
        productOrders = await Order.find({
          technicianId: tech._id,
          status: { $nin: ["cancelled", "completed"] },
        })
          .sort({ "delivery.preferredDate": 1, createdAt: 1 })
          .limit(50)
          .lean();
      }

      res.render("pages/technician/techniciandashboard", {
        title: "Technician Dashboard",
        layout: "layouts/technician",
        technician: tech || {},
        initialAppointments: appointments,
        initialProductOrders: productOrders,
      });
    } catch (e) {
      next(e);
    }
  },
);

// personal schedule view — redirects to unified My Work page
router.get(
  "/technician/schedule",
  pageAuth.requireRole("technician"),
  (req, res) => {
    res.redirect("/technician/assignments");
  }
);

// technician analytics page
router.get(
  "/technician/analytics",
  pageAuth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const mongoose = require("mongoose");
      const Technician = require("../models/Technician");
      const BookingService = require("../models/BookingService");
      const Order = require("../models/Order");
      const tech = await Technician.findOne({ user: req.user._id }).lean();

      let allBookings = [];
      let allOrders = [];
      let stats = { totalServicePrice: 0, totalEstimatedFee: 0, totalTravelFare: 0, completedCount: 0 };

      if (tech && tech._id) {
        const technicianIds = [String(tech._id)];
        if (tech.user) technicianIds.push(String(tech.user));
        if (req.user && req.user._id) technicianIds.push(String(req.user._id));
        const objectIds = Array.from(new Set(technicianIds)).map(id => {
          try { return new mongoose.Types.ObjectId(id); } catch(e) { return id; }
        });

        // Fetch all bookings for this technician (last 12 months)
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        twelveMonthsAgo.setHours(0, 0, 0, 0);

        allBookings = await BookingService.find({
          technicianId: { $in: objectIds },
          $or: [
            { bookingDate: { $gte: twelveMonthsAgo } },
            { createdAt: { $gte: twelveMonthsAgo } }
          ]
        })
          .select("bookingDate startTime endTime status servicePrice estimatedFee travelFare customerRating service serviceType customerName createdAt paymentMethod paymentStatus")
          .sort({ bookingDate: -1 })
          .limit(500)
          .lean();

        // Fetch all orders for this technician (last 12 months)
        allOrders = await Order.find({
          technicianId: { $in: objectIds },
          createdAt: { $gte: twelveMonthsAgo }
        })
          .select("status fulfillmentType total subtotal transportationFee installationFee delivery.preferredDate customer.name items.modelLine orderReference createdAt paymentMethod paymentStatus timeSlot")
          .sort({ createdAt: -1 })
          .limit(500)
          .lean();

        // Aggregated stats for completed bookings
        const agg = await BookingService.aggregate([
          { $match: { technicianId: { $in: objectIds }, status: "completed" } },
          { $group: {
              _id: null,
              totalServicePrice: { $sum: { $ifNull: ["$servicePrice", 0] } },
              totalEstimatedFee: { $sum: { $ifNull: ["$estimatedFee", 0] } },
              totalTravelFare: { $sum: { $ifNull: ["$travelFare", 0] } },
              completedCount: { $sum: 1 },
              avgRating: { $avg: "$customerRating" },
              ratingCount: { $sum: { $cond: [{ $gt: ["$customerRating", 0] }, 1, 0] } },
          } },
        ]);
        if (agg && agg.length) {
          stats = {
            totalServicePrice: agg[0].totalServicePrice || 0,
            totalEstimatedFee: agg[0].totalEstimatedFee || 0,
            totalTravelFare: agg[0].totalTravelFare || 0,
            completedCount: agg[0].completedCount || 0,
            avgRating: agg[0].avgRating ? Math.round(agg[0].avgRating * 10) / 10 : null,
            ratingCount: agg[0].ratingCount || 0,
          };
        }
      }

      res.render("pages/technician/analytics", {
        title: "Technician Analytics",
        layout: "layouts/technician",
        technician: tech || {},
        stats,
        allBookings,
        allOrders,
      });
    } catch (e) {
      next(e);
    }
  },
);

// technician attendance page
router.get(
  "/technician/attendance",
  pageAuth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const Technician = require("../models/Technician");
      const tech = await Technician.findOne({ user: req.user._id }).lean();

      res.render("pages/technician/Attendance", {
        title: "Technician Attendance",
        layout: "layouts/technician",
        technician: tech || {},
      });
    } catch (e) {
      next(e);
    }
  },
);

// technician orders page
router.get(
  "/technician/orders",
  pageAuth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const Technician = require("../models/Technician");
      const tech = await Technician.findOne({ user: req.user._id }).lean();

      res.render("pages/technician/technicianorders", {
        title: "Order Management",
        layout: "layouts/technician",
        technician: tech || {},
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── Technician Enterprise Dashboard Pages ─────────────────────────────────────

// My Assignments
router.get(
  "/technician/assignments",
  pageAuth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const Technician = require("../models/Technician");
      const tech = await Technician.findOne({ user: req.user._id }).lean();
      const companyLoc = await getCompanyLocation();
      res.render("pages/technician/assignments", {
        title: "My Assignments",
        layout: "layouts/technician",
        technician: tech || {},
        companyLat: companyLoc.lat,
        companyLng: companyLoc.lng,
        companyAddress: companyLoc.address,
      });
    } catch (e) { next(e); }
  },
);

// Expenses
router.get(
  "/technician/expenses",
  pageAuth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const Technician = require("../models/Technician");
      const tech = await Technician.findOne({ user: req.user._id }).lean();
      res.render("pages/technician/expenses", {
        title: "Expenses",
        layout: "layouts/technician",
        technician: tech || {},
      });
    } catch (e) { next(e); }
  },
);

// My Tools
router.get(
  "/technician/tools",
  pageAuth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const Technician = require("../models/Technician");
      const tech = await Technician.findOne({ user: req.user._id }).lean();
      res.render("pages/technician/tools", {
        title: "My Tools",
        layout: "layouts/technician",
        technician: tech || {},
      });
    } catch (e) { next(e); }
  },
);

// Service Reports
router.get(
  "/technician/reports",
  pageAuth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const Technician = require("../models/Technician");
      const tech = await Technician.findOne({ user: req.user._id }).lean();
      res.render("pages/technician/reports", {
        title: "Service Reports",
        layout: "layouts/technician",
        technician: tech || {},
      });
    } catch (e) { next(e); }
  },
);

// Live Tracking
router.get(
  "/technician/tracking",
  pageAuth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const Technician = require("../models/Technician");
      const tech = await Technician.findOne({ user: req.user._id }).lean();
      res.render("pages/technician/tracking", {
        title: "Live Tracking",
        layout: "layouts/technician",
        technician: tech || {},
      });
    } catch (e) { next(e); }
  },
);

// Legacy project work-order page. Technicians now work exclusively from the
// unified "My Work" page, which frames everything as today's assignment and
// never exposes raw work orders to members. Redirect to keep old links working.
router.get(
  "/technician/projects",
  pageAuth.requireRole("technician"),
  (req, res) => {
    res.redirect("/technician/assignments");
  },
);

router.get(
  "/admin/technicians/schedules",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Technicians/Schedules", {
      title: "Technician Schedules",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/technicians/skills",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Technicians/Skills", {
      title: "Technician Skills",
      layout: "layouts/admin",
    });
  },
);

// Admin - Technician Leave Requests
router.get(
  "/admin/technicians/leaves",
  pageAuth.requireRole("admin"),
  async (req, res, next) => {
    try {
      const LeaveRequest = require("../models/LeaveRequest");
      const [items, pendingCount] = await Promise.all([
        LeaveRequest.find({}).sort({ status: 1, createdAt: -1 }).limit(500).lean(),
        LeaveRequest.countDocuments({ status: "pending" }),
      ]);
      res.render("pages/admin/Technicians/TechnicianLeaves", {
        title:        "Leave Requests",
        layout:       "layouts/admin",
        initialLeaves: items,
        pendingCount,
      });
    } catch (e) {
      next(e);
    }
  },
);

// Admin - Service Tracking
router.get(
  "/admin/service-tracking",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/shared/ServiceTracking", {
      title: "Service Tracking",
      layout: "layouts/admin",
      apiBase: "/api/admin",
      roleLabel: "Admin",
    });
  },
);

// Admin - Project Management
router.get(
  "/admin/projects",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Projects/ProjectList", {
      title: "Project Management",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/projects/:id",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Projects/ProjectDetail", {
      title: "Project Detail",
      layout: "layouts/admin",
    });
  },
);

// Admin - Notifications & Roles (scaffolded placeholders)
router.get(
  "/admin/notifications",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Notifications/Notifications", {
      title: "Notifications",
      layout: "layouts/admin",
    });
  },
);
router.get("/admin/roles", pageAuth.requireRole("admin"), async (req, res) => {
  let roles = [];
  let catalog = [];
  try {
    const Role = require("../models/Role");
    const User = require("../models/User");
    const {
      PERMISSION_CATALOG,
    } = require("../middleware/requirePermission");
    roles = await Role.find({}).lean();
    // attach user counts
    const counts = await User.aggregate([
      { $match: { role: { $in: roles.map((r) => r.name) } } },
      { $group: { _id: "$role", count: { $sum: 1 } } },
    ]);
    const countMap = counts.reduce((m, c) => {
      m[c._id] = c.count;
      return m;
    }, {});
    roles.forEach((r) => {
      r.userCount = countMap[r.name] || 0;
    });
    catalog = PERMISSION_CATALOG;
  } catch (e) {
    console.error("/admin/roles data fetch failed", e && e.message);
  }
  res.render("pages/admin/Roles/Roles", {
    title: "Roles & Permissions",
    layout: "layouts/admin",
    roles,
    catalog,
  });
});

// Admin - Reports
router.get(
  "/admin/reports/service",
  pageAuth.requireRole("admin"),
  async (req, res) => {
    try {
      const BookingService = require("../models/BookingService");
      const Technician = require("../models/Technician");
      const User = require("../models/User");
      const Order = require("../models/Order");
      
      // Get date ranges
      const now = new Date();
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const sixtyDaysAgo = new Date(now);
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      const ninetyDaysAgo = new Date(now);
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      
      // Fetch bookings with all needed data
      const bookings = await BookingService.find({
        createdAt: { $gte: ninetyDaysAgo }
      }).lean();
      
      // Get technicians for performance data
      const technicians = await Technician.find({}).lean();

      // Compute active technicians (checked in today and available)
      const TechnicianAttendance = require("../models/TechnicianAttendance");
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const todayAttendance = await TechnicianAttendance.find({
        date: startOfToday,
        status: { $in: ["Present", "Late"] },
        checkOutTime: { $exists: false },
      }).select("technicianId").lean();
      const activeTechIds = new Set(todayAttendance.map(a => a.technicianId.toString()));
      const activeTechnicians = technicians.filter(t => t.active && activeTechIds.has(String(t._id)));
      const activeTechnicianCount = activeTechnicians.length;

      // Count currently in-progress bookings
      const inProgressCount = bookings.filter(b => ["on-the-way", "in-progress", "arrived"].includes(b.status)).length;
      
      // Calculate core analytics
      const totalBookings = bookings.length;
      const completedBookings = bookings.filter(b => b.status === "completed").length;
      const pendingBookings = bookings.filter(b => ["pending", "confirmed", "scheduled"].includes(b.status)).length;
      const cancelledBookings = bookings.filter(b => b.status === "cancelled").length;
      const inProgressBookings = bookings.filter(b => ["on-the-way", "in-progress", "arrived"].includes(b.status)).length;
      
      // Detailed status breakdown
      const statusBreakdown = {};
      bookings.forEach(b => {
        statusBreakdown[b.status] = (statusBreakdown[b.status] || 0) + 1;
      });
      
      // Payment method breakdown
      const gcashBookings = bookings.filter(b => b.paymentMethod === "gcash").length;
      const codBookings = bookings.filter(b => b.paymentMethod === "cod").length;
      const otherPaymentBookings = totalBookings - gcashBookings - codBookings;
      
      // Service type breakdown
      const coreServiceBookings = bookings.filter(b => b.serviceType === "core" || (b.services && b.services.some(s => s.type === "core"))).length;
      const repairBookings = bookings.filter(b => b.serviceType === "repair" || (b.services && b.services.some(s => s.type === "repair"))).length;
      const multiServiceBookings = bookings.filter(b => b.isMultiService).length;
      
      // Calculate revenue from bookings
      const totalRevenue = bookings.reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);
      const completedRevenue = bookings
        .filter(b => b.status === "completed")
        .reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);
      const pendingRevenue = bookings
        .filter(b => ["pending", "confirmed", "scheduled"].includes(b.status))
        .reduce((sum, b) => sum + (b.estimatedFee || b.totalPrice || 0), 0);
      
      const avgBookingValue = totalBookings > 0 ? totalRevenue / totalBookings : 0;
      
      // Technician utilization analysis
      const technicianStats = {};
      bookings.forEach(b => {
        if (b.technicianId) {
          const techId = b.technicianId.toString();
          if (!technicianStats[techId]) {
            technicianStats[techId] = {
              id: techId,
              name: b.technician?.name || "Unknown",
              totalBookings: 0,
              completedBookings: 0,
              cancelledBookings: 0,
              revenue: 0,
              ratings: []
            };
          }
          technicianStats[techId].totalBookings++;
          technicianStats[techId].revenue += (b.totalPrice || b.estimatedFee || 0);
          if (b.status === "completed") technicianStats[techId].completedBookings++;
          if (b.status === "cancelled") technicianStats[techId].cancelledBookings++;
          if (b.customerRating) technicianStats[techId].ratings.push(b.customerRating);
        }
      });
      
      // Calculate technician averages
      Object.values(technicianStats).forEach(stats => {
        stats.completionRate = stats.totalBookings > 0 ? (stats.completedBookings / stats.totalBookings) : 0;
        stats.avgRating = stats.ratings.length > 0 ? (stats.ratings.reduce((a, b) => a + b, 0) / stats.ratings.length) : 0;
      });
      
      const topTechnicians = Object.values(technicianStats)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);
      
      // Ratings analysis
      const ratedBookings = bookings.filter(b => b.customerRating);
      const avgRating = ratedBookings.length > 0 
        ? ratedBookings.reduce((sum, b) => sum + b.customerRating, 0) / ratedBookings.length 
        : 0;
      
      const ratingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      ratedBookings.forEach(b => {
        if (b.customerRating >= 1 && b.customerRating <= 5) {
          ratingDistribution[b.customerRating]++;
        }
      });
      
      // Weekly trend data (last 12 weeks)
      const weeklyData = {};
      for (let i = 0; i < 12; i++) {
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - (i * 7));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);
        
        const weekBookings = bookings.filter(b => {
          const date = new Date(b.createdAt);
          return date >= weekStart && date < weekEnd;
        });
        
        const weekKey = `W${12-i}`;
        weeklyData[weekKey] = {
          bookings: weekBookings.length,
          revenue: weekBookings.reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0),
          completed: weekBookings.filter(b => b.status === "completed").length
        };
      }
      
      // Daily booking trend (last 7 days) for booking volume chart
      const dailyTrend = [];
      for (let i = 6; i >= 0; i--) {
        const dayStart = new Date(now);
        dayStart.setDate(dayStart.getDate() - i);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const dayBookings = bookings.filter(b => {
          const d = new Date(b.createdAt);
          return d >= dayStart && d < dayEnd;
        });
        dailyTrend.push({
          day: dayStart.toLocaleDateString("en-US", { weekday: "short" }),
          date: dayStart.toISOString().slice(0, 10),
          bookings: dayBookings.length,
          completed: dayBookings.filter(b => b.status === "completed").length,
        });
      }

      // Service-level aggregation for Top Performing Services table
      const serviceAggMap = {};
      bookings.forEach(b => {
        const sName = b.service?.name || b.serviceType || "Unknown";
        if (!serviceAggMap[sName]) {
          serviceAggMap[sName] = { name: sName, bookings: 0, completed: 0, revenue: 0, ratings: [] };
        }
        serviceAggMap[sName].bookings++;
        serviceAggMap[sName].revenue += (b.totalPrice || b.estimatedFee || 0);
        if (b.status === "completed") serviceAggMap[sName].completed++;
        if (b.customerRating) serviceAggMap[sName].ratings.push(b.customerRating);
      });
      const topServices = Object.values(serviceAggMap)
        .map(s => ({
          ...s,
          completionRate: s.bookings > 0 ? (s.completed / s.bookings) * 100 : 0,
          avgRating: s.ratings.length > 0 ? (s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length) : 0,
          avgRevenue: s.bookings > 0 ? s.revenue / s.bookings : 0,
        }))
        .sort((a, b) => b.bookings - a.bookings)
        .slice(0, 5);

      // Technician utilization percentages for chart
      const techUtilization = Object.values(technicianStats)
        .map(t => ({
          name: t.name,
          completed: t.completedBookings,
          total: t.totalBookings,
          utilization: t.totalBookings > 0 ? Math.round((t.completedBookings / t.totalBookings) * 100) : 0,
        }))
        .sort((a, b) => b.utilization - a.utilization)
        .slice(0, 10);

      // Weekly customer satisfaction data (last 6 weeks average rating)
      const weeklyCsat = [];
      for (let i = 5; i >= 0; i--) {
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - (i * 7));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);
        const weekRated = bookings.filter(b => {
          const d = new Date(b.createdAt);
          return d >= weekStart && d < weekEnd && b.customerRating;
        });
        const avg = weekRated.length > 0 ? weekRated.reduce((s, b) => s + b.customerRating, 0) / weekRated.length : 0;
        weeklyCsat.push({ week: `W${i + 1}`, avg });
      }

      // Recent bookings for activity feed
      const recentBookings = bookings
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map(b => ({
          id: b._id,
          reference: b.bookingReference,
          customer: b.customer?.name || "Unknown",
          service: b.service?.name || b.serviceType || "Unknown",
          status: b.status,
          amount: getBookingRevenue(b),
          date: b.createdAt,
          technician: b.technician?.name || "Unassigned"
        }));

      // ── Senior Analyst: Advanced Analytics ──────────────────────────────

      // Proper revenue calculation (matches RevenueReports logic)
      function getBookingRevenue(b) {
        const isRepair = b.serviceType === "repair" ||
          (b.services && b.services.some(s => s.type === "repair"));
        if (isRepair) {
          const inspectionRevenue = b.inspectionFeeTotalCollected || b.initialCost || 0;
          const quotationRevenue = (b.quotation && b.quotation.totalCost) || 0;
          return inspectionRevenue + quotationRevenue;
        }
        return b.totalPrice || b.estimatedFee || 0;
      }

      // Recalculate revenue with proper logic
      const accurateTotalRevenue = bookings.reduce((sum, b) => sum + getBookingRevenue(b), 0);
      const accurateCompletedRevenue = bookings
        .filter(b => b.status === "completed")
        .reduce((sum, b) => sum + getBookingRevenue(b), 0);
      const accurateAvgBookingValue = totalBookings > 0 ? accurateTotalRevenue / totalBookings : 0;

      // Revenue by service type (proper calc)
      const coreRevenueAccurate = bookings
        .filter(b => b.serviceType === "core" || (b.services && b.services.some(s => s.type === "core")))
        .reduce((sum, b) => sum + getBookingRevenue(b), 0);
      const repairRevenueAccurate = bookings
        .filter(b => b.serviceType === "repair" || (b.services && b.services.some(s => s.type === "repair")))
        .reduce((sum, b) => sum + getBookingRevenue(b), 0);

      // ── Service Report Workflow Stats (from ServiceReport model) ────────
      let serviceReportStats = { draft: 0, submitted: 0, approved: 0, revision_requested: 0, total: 0, avgLaborHours: 0, totalPartsCost: 0, totalLaborCost: 0, followUpRequired: 0 };
      try {
        const ServiceReport = require("../models/ServiceReport");
        const reportAgg = await ServiceReport.aggregate([
          { $match: { createdAt: { $gte: ninetyDaysAgo } } },
          { $group: {
            _id: "$status",
            count: { $sum: 1 },
            avgLaborHours: { $avg: "$laborHours" },
            totalPartsCost: { $sum: "$partsCost" },
            totalLaborCost: { $sum: "$laborCost" },
            followUpRequired: { $sum: { $cond: ["$followUpRequired", 1, 0] } }
          }}
        ]);
        reportAgg.forEach(r => {
          serviceReportStats[r._id] = r.count;
          serviceReportStats.total += r.count;
          serviceReportStats.avgLaborHours += (r.avgLaborHours || 0) * r.count;
          serviceReportStats.totalPartsCost += (r.totalPartsCost || 0);
          serviceReportStats.totalLaborCost += (r.totalLaborCost || 0);
          serviceReportStats.followUpRequired += (r.followUpRequired || 0);
        });
        serviceReportStats.avgLaborHours = serviceReportStats.total > 0 ? serviceReportStats.avgLaborHours / serviceReportStats.total : 0;
      } catch (e) { /* ServiceReport model may not exist yet */ }

      // ── Cancellation Analysis ────────────────────────────────────────────
      const cancelledBookingsList = bookings.filter(b => b.status === "cancelled");
      const cancellationRate = totalBookings > 0 ? (cancelledBookingsList.length / totalBookings) * 100 : 0;
      const cancellationReasons = {};
      cancelledBookingsList.forEach(b => {
        const reason = b.cancellationReason || "Unspecified";
        cancellationReasons[reason] = (cancellationReasons[reason] || 0) + 1;
      });
      const cancellationReasonsArray = Object.entries(cancellationReasons)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);

      // Weekly cancellation trend
      const weeklyCancellation = [];
      for (let i = 11; i >= 0; i--) {
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - (i * 7));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);
        const weekCancelled = bookings.filter(b => {
          const d = new Date(b.createdAt);
          return d >= weekStart && d < weekEnd && b.status === "cancelled";
        }).length;
        const weekTotal = bookings.filter(b => {
          const d = new Date(b.createdAt);
          return d >= weekStart && d < weekEnd;
        }).length;
        weeklyCancellation.push({
          week: `W${12-i}`,
          cancelled: weekCancelled,
          rate: weekTotal > 0 ? (weekCancelled / weekTotal) * 100 : 0
        });
      }

      // ── Customer Retention Analysis ─────────────────────────────────────
      const customerBookingCounts = {};
      bookings.forEach(b => {
        if (b.customerId) {
          const cid = b.customerId.toString();
          customerBookingCounts[cid] = (customerBookingCounts[cid] || 0) + 1;
        }
      });
      const uniqueCustomers = Object.keys(customerBookingCounts).length;
      const repeatCustomers = Object.values(customerBookingCounts).filter(c => c > 1).length;
      const retentionRate = uniqueCustomers > 0 ? (repeatCustomers / uniqueCustomers) * 100 : 0;
      const customerSegments = {
        oneTime: Object.values(customerBookingCounts).filter(c => c === 1).length,
        returning: Object.values(customerBookingCounts).filter(c => c >= 2 && c <= 4).length,
        loyal: Object.values(customerBookingCounts).filter(c => c >= 5).length,
      };

      // ── Parts & Materials Cost Analysis ─────────────────────────────────
      let totalQuotationPartsCost = 0;
      let totalQuotationLaborCost = 0;
      const partsCostByService = {};
      bookings.forEach(b => {
        if (b.quotation && b.quotation.parts && b.quotation.totalCost > 0) {
          const partsCost = b.quotation.parts.reduce((ps, p) => ps + ((p.cost || 0) * (p.quantity || 1)), 0);
          const laborCost = b.quotation.laborCost || 0;
          totalQuotationPartsCost += partsCost;
          totalQuotationLaborCost += laborCost;
          const sName = b.service?.name || b.serviceType || "Unknown";
          if (!partsCostByService[sName]) {
            partsCostByService[sName] = { name: sName, partsCost: 0, laborCost: 0, jobCount: 0 };
          }
          partsCostByService[sName].partsCost += partsCost;
          partsCostByService[sName].laborCost += laborCost;
          partsCostByService[sName].jobCount++;
        }
      });
      const partsCostByServiceArray = Object.values(partsCostByService)
        .sort((a, b) => b.partsCost - a.partsCost)
        .slice(0, 8);

      // ── SLA Compliance Metrics ──────────────────────────────────────────
      let slaStats = { responseBreached: 0, resolutionBreached: 0, totalWithSLA: 0, responseCompliance: 100, resolutionCompliance: 100 };
      bookings.forEach(b => {
        if (b.slaTracking && (b.slaTracking.responseTarget || b.slaTracking.resolutionTarget)) {
          slaStats.totalWithSLA++;
          if (b.slaTracking.responseBreached) slaStats.responseBreached++;
          if (b.slaTracking.resolutionBreached) slaStats.resolutionBreached++;
        }
      });
      if (slaStats.totalWithSLA > 0) {
        slaStats.responseCompliance = ((slaStats.totalWithSLA - slaStats.responseBreached) / slaStats.totalWithSLA) * 100;
        slaStats.resolutionCompliance = ((slaStats.totalWithSLA - slaStats.resolutionBreached) / slaStats.totalWithSLA) * 100;
      }

      // ── Priority Distribution ───────────────────────────────────────────
      const priorityBreakdown = { low: 0, medium: 0, high: 0, critical: 0 };
      bookings.forEach(b => {
        const p = b.priority || "medium";
        priorityBreakdown[p] = (priorityBreakdown[p] || 0) + 1;
      });

      // ── Geographic Distribution ─────────────────────────────────────────
      const areaDistribution = {};
      bookings.forEach(b => {
        const addr = b.location?.address || b.customer?.address || "";
        if (addr) {
          const parts = addr.split(",").map(s => s.trim());
          const area = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
          if (area && area.length > 2) {
            areaDistribution[area] = (areaDistribution[area] || 0) + 1;
          }
        }
      });
      const topAreas = Object.entries(areaDistribution)
        .map(([area, count]) => ({ area, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      // ── Appliance Type Breakdown ────────────────────────────────────────
      const applianceBreakdown = {};
      bookings.forEach(b => {
        const type = b.applianceTypeName || b.applianceType || "Unknown";
        applianceBreakdown[type] = (applianceBreakdown[type] || 0) + 1;
      });
      const applianceArray = Object.entries(applianceBreakdown)
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);

      // ── Warranty Stats ──────────────────────────────────────────────────
      const warrantyStats = { active: 0, expired: 0, claimed: 0, total: 0 };
      bookings.forEach(b => {
        if (b.warranty && b.warranty.status) {
          warrantyStats[b.warranty.status] = (warrantyStats[b.warranty.status] || 0) + 1;
          warrantyStats.total++;
        }
      });

      // ── Assignment Efficiency ────────────────────────────────────────────
      const assignedBookings = bookings.filter(b => b.assignedAt);
      const avgAssignmentTime = assignedBookings.length > 0
        ? assignedBookings.reduce((sum, b) => {
            const created = new Date(b.createdAt);
            const assigned = new Date(b.assignedAt);
            return sum + (assigned - created);
          }, 0) / assignedBookings.length
        : 0;
      const avgAssignmentHours = avgAssignmentTime > 0 ? avgAssignmentTime / (1000 * 60 * 60) : 0;

      // ── Revenue Trend (monthly, last 6 months) ──────────────────────────
      const monthlyRevenueTrend = [];
      for (let i = 5; i >= 0; i--) {
        const monthStart = new Date(now);
        monthStart.setMonth(monthStart.getMonth() - i);
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthEnd = new Date(monthStart);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        const monthBookings = bookings.filter(b => {
          const d = new Date(b.createdAt);
          return d >= monthStart && d < monthEnd;
        });
        const monthRevenue = monthBookings.reduce((sum, b) => sum + getBookingRevenue(b), 0);
        const monthCore = monthBookings
          .filter(b => b.serviceType === "core" || (b.services && b.services.some(s => s.type === "core")))
          .reduce((sum, b) => sum + getBookingRevenue(b), 0);
        const monthRepair = monthBookings
          .filter(b => b.serviceType === "repair" || (b.services && b.services.some(s => s.type === "repair")))
          .reduce((sum, b) => sum + getBookingRevenue(b), 0);
        monthlyRevenueTrend.push({
          month: monthStart.toLocaleString('default', { month: 'short' }),
          total: monthRevenue,
          core: monthCore,
          repair: monthRepair,
          bookings: monthBookings.length
        });
      }

      res.render("pages/admin/Reports/ServiceReport", {
        title: "Service Reports",
        layout: "layouts/admin",
        analytics: {
          totalBookings,
          completedBookings,
          pendingBookings,
          cancelledBookings,
          inProgressBookings,
          gcashBookings,
          codBookings,
          otherPaymentBookings,
          coreServiceBookings,
          repairBookings,
          multiServiceBookings,
          totalRevenue,
          completedRevenue,
          pendingRevenue,
          avgBookingValue,
          avgRating: avgRating.toFixed(1),
          ratingDistribution,
          statusBreakdown,
          technicianStats,
          topTechnicians,
          weeklyData,
          dailyTrend,
          topServices,
          techUtilization,
          weeklyCsat,
          recentBookings,
          activeTechnicianCount,
          inProgressCount,
          technicians: technicians.map(t => ({
            _id: t._id,
            name: t.name,
            email: t.userEmail,
            specialization: t.specialization,
            active: t.active
          })),
          // Senior Analyst additions
          accurateTotalRevenue,
          accurateCompletedRevenue,
          accurateAvgBookingValue,
          coreRevenueAccurate,
          repairRevenueAccurate,
          serviceReportStats,
          cancellationRate,
          cancellationReasonsArray,
          weeklyCancellation,
          uniqueCustomers,
          repeatCustomers,
          retentionRate,
          customerSegments,
          totalQuotationPartsCost,
          totalQuotationLaborCost,
          partsCostByServiceArray,
          slaStats,
          priorityBreakdown,
          topAreas,
          applianceArray,
          warrantyStats,
          avgAssignmentHours,
          monthlyRevenueTrend
        }
      });
    } catch (err) {
      console.error("Service reports error:", err);
      res.render("pages/admin/Reports/ServiceReport", {
        title: "Service Reports",
        layout: "layouts/admin",
        analytics: null
      });
    }
  },
);
router.get(
  "/admin/reports/inventory",
  pageAuth.requireRole("admin"),
  async (req, res) => {
    try {
      const Inventory = require("../models/Inventory");
      const Tool = require("../models/Tool");
      const HVACProduct = require("../models/HVACProduct");
      const ServiceToolUsage = require("../models/ServiceToolUsage");
      
      // Fetch all inventory items
      const inventoryItems = await Inventory.find({}).lean();
      const tools = await Tool.find({}).lean();
      
      // Calculate stock analytics
      const totalProducts = inventoryItems.length;
      const inStock = inventoryItems.filter(i => i.status === "in_stock").length;
      const lowStock = inventoryItems.filter(i => i.status === "low_stock").length;
      const outOfStock = inventoryItems.filter(i => i.status === "out_of_stock").length;
      const discontinued = inventoryItems.filter(i => i.status === "discontinued").length;
      
      // Tools analytics
      const totalTools = tools.length;
      const toolsInStock = tools.filter(t => t.status === "in_stock").length;
      const toolsLowStock = tools.filter(t => t.status === "low_stock").length;
      const toolsOutOfStock = tools.filter(t => t.status === "out_of_stock").length;
      
      // Calculate inventory value with detailed breakdown
      const inventoryValue = inventoryItems.reduce((sum, i) => sum + (i.sellingPrice * i.quantity || 0), 0);
      const inventoryCost = inventoryItems.reduce((sum, i) => sum + (i.costPrice * i.quantity || 0), 0);
      const toolsValue = tools.reduce((sum, t) => sum + (t.sellingPrice * t.quantity || 0), 0);
      const toolsCost = tools.reduce((sum, t) => sum + (t.costPrice * t.quantity || 0), 0);
      
      // Category breakdown (by type for Inventory)
      const typeCounts = {};
      const typeValues = {};
      inventoryItems.forEach(i => {
        typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
        typeValues[i.type] = (typeValues[i.type] || 0) + (i.sellingPrice * i.quantity || 0);
      });
      
      // Stock levels by product - top 15 by value
      const stockLevels = inventoryItems
        .map(i => ({
          name: i.modelLine || i.displayLabel || "Unknown",
          quantity: i.quantity,
          minStock: i.minStockLevel,
          status: i.status,
          value: (i.sellingPrice * i.quantity) || 0,
          cost: (i.costPrice * i.quantity) || 0,
          margin: ((i.sellingPrice - i.costPrice) * i.quantity) || 0,
          type: i.type
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 15);
      
      // Low stock alerts with priority scoring
      const lowStockAlerts = [
        ...inventoryItems.filter(i => i.status === "low_stock").map(i => ({
          id: i._id,
          name: i.modelLine || i.displayLabel,
          quantity: i.quantity,
          minStock: i.minStockLevel,
          type: "product",
          priority: i.quantity === 0 ? "critical" : (i.quantity <= i.minStockLevel * 0.5 ? "high" : "medium"),
          value: (i.sellingPrice * i.quantity) || 0,
          daysOfStock: Math.round(i.quantity / Math.max(i.minStockLevel / 7, 1)) // estimated days remaining
        })),
        ...tools.filter(t => t.status === "low_stock").map(t => ({
          id: t._id,
          name: t.itemName,
          quantity: t.quantity,
          minStock: t.minStockLevel,
          type: "tool",
          priority: t.quantity === 0 ? "critical" : (t.quantity <= t.minStockLevel * 0.5 ? "high" : "medium"),
          value: (t.sellingPrice * t.quantity) || 0,
          daysOfStock: Math.round(t.quantity / Math.max(t.minStockLevel / 7, 1))
        }))
      ].sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority] || a.quantity - b.quantity;
      });
      
      // Calculate inventory health score
      const totalItems = totalProducts + totalTools;
      const healthyItems = inStock + toolsInStock;
      const inventoryHealthScore = totalItems > 0 ? Math.round((healthyItems / totalItems) * 100) : 0;
      
      // Tool usage analytics (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const toolUsage = await ServiceToolUsage.find({
        usedAt: { $gte: thirtyDaysAgo }
      }).lean();
      
      const totalToolUsage = toolUsage.reduce((sum, u) => sum + (u.quantityUsed || 0), 0);
      const toolUsageValue = toolUsage.reduce((sum, u) => sum + ((u.quantityUsed || 0) * (u.unitPrice || 0)), 0);
      
      // Most used tools
      const toolUsageMap = {};
      toolUsage.forEach(u => {
        const name = u.itemName || "Unknown";
        toolUsageMap[name] = (toolUsageMap[name] || 0) + (u.quantityUsed || 0);
      });
      const topUsedTools = Object.entries(toolUsageMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, quantity]) => ({ name, quantity }));
      
      // Stock turnover estimate (usage vs stock)
      const stockTurnover = tools.map(t => {
        const usage = toolUsageMap[t.itemName] || 0;
        return {
          name: t.itemName,
          stock: t.quantity,
          usage30d: usage,
          turnoverRate: t.quantity > 0 ? (usage / t.quantity) : 0,
          status: t.status
        };
      }).sort((a, b) => b.turnoverRate - a.turnoverRate).slice(0, 10);
      
      res.render("pages/admin/Reports/InventoryReports", {
        title: "Inventory Reports",
        layout: "layouts/admin",
        analytics: {
          totalProducts,
          inStock,
          lowStock,
          outOfStock,
          discontinued,
          totalTools,
          toolsInStock,
          toolsLowStock,
          toolsOutOfStock,
          inventoryValue,
          inventoryCost,
          toolsValue,
          toolsCost,
          totalValue: inventoryValue + toolsValue,
          totalCost: inventoryCost + toolsCost,
          typeCounts,
          typeValues,
          stockLevels,
          lowStockAlerts: lowStockAlerts.slice(0, 15),
          profitPotential: (inventoryValue - inventoryCost) + (toolsValue - toolsCost),
          inventoryHealthScore,
          totalToolUsage,
          toolUsageValue,
          topUsedTools,
          stockTurnover
        }
      });
    } catch (err) {
      console.error("Inventory reports error:", err);
      res.render("pages/admin/Reports/InventoryReports", {
        title: "Inventory Reports",
        layout: "layouts/admin",
        analytics: null
      });
    }
  },
);
router.get(
  "/admin/reports/revenue",
  pageAuth.requireRole("admin"),
  async (req, res) => {
    try {
      const BookingService = require("../models/BookingService");
      const Payment = require("../models/Payment");
      const Order = require("../models/Order");
      
      // Get date ranges
      const now = new Date();
      const twelveMonthsAgo = new Date(now);
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      // Fetch all revenue data
      const bookings = await BookingService.find({
        createdAt: { $gte: twelveMonthsAgo }
      }).lean();
      
      const payments = await Payment.find({
        submittedAt: { $gte: twelveMonthsAgo },
        status: { $in: ["paid", "partial"] }
      }).lean();
      
      const orders = await Order.find({
        createdAt: { $gte: twelveMonthsAgo }
      }).lean();
      
      // Helper: calculate correct revenue for a booking
      // Core services: use totalPrice (fixed price)
      // Repair services: inspection fee collected + quotation total (if exists)
      function getBookingRevenue(b) {
        const isRepair = b.serviceType === "repair" ||
          (b.services && b.services.some(s => s.type === "repair"));
        if (isRepair) {
          const inspectionRevenue = b.inspectionFeeTotalCollected || b.initialCost || 0;
          // Include quotation total if it exists and has a value (regardless of approval status)
          // A quotation with totalCost > 0 means the technician submitted it and it represents the job scope
          const quotationRevenue = (b.quotation && b.quotation.totalCost) || 0;
          return inspectionRevenue + quotationRevenue;
        }
        return b.totalPrice || b.estimatedFee || 0;
      }
      
      // Calculate revenue metrics
      const serviceRevenue = bookings.reduce((sum, b) => sum + getBookingRevenue(b), 0);
      const orderRevenue = orders.reduce((sum, o) => sum + (o.total || o.totalAmount || 0), 0);
      const paymentRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
      
      const totalRevenue = serviceRevenue + orderRevenue;
      
      // Revenue by source
      const productRevenue = orders.reduce((sum, o) => sum + (o.subtotal || 0), 0);
      const deliveryRevenue = orders.reduce((sum, o) => sum + (o.deliveryFee || 0), 0);
      const installationRevenue = orders.reduce((sum, o) => sum + (o.installationFee || 0), 0);
      
      // Payment method breakdown
      const gcashRevenue = payments
        .filter(p => p.method === "gcash")
        .reduce((sum, p) => sum + p.amount, 0);
      const codRevenue = payments
        .filter(p => p.method === "cod")
        .reduce((sum, p) => sum + p.amount, 0);
      const bankRevenue = payments
        .filter(p => p.method === "bank")
        .reduce((sum, p) => sum + p.amount, 0);
      const otherRevenue = paymentRevenue - gcashRevenue - codRevenue - bankRevenue;
      
      // Monthly revenue trend
      const monthlyRevenue = {};
      for (let i = 0; i < 12; i++) {
        const monthStart = new Date(now);
        monthStart.setMonth(monthStart.getMonth() - i);
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthEnd = new Date(monthStart);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        
        const monthBookings = bookings.filter(b => {
          const date = new Date(b.createdAt);
          return date >= monthStart && date < monthEnd;
        });
        const monthOrders = orders.filter(o => {
          const date = new Date(o.createdAt);
          return date >= monthStart && date < monthEnd;
        });
        
        const monthKey = monthStart.toLocaleString('default', { month: 'short' });
        monthlyRevenue[monthKey] = {
          service: monthBookings.reduce((sum, b) => sum + getBookingRevenue(b), 0),
          orders: monthOrders.reduce((sum, o) => sum + (o.total || o.totalAmount || 0), 0),
          total: 0
        };
        monthlyRevenue[monthKey].total = monthlyRevenue[monthKey].service + monthlyRevenue[monthKey].orders;
      }
      
      // Revenue by service type
      const coreRevenue = bookings
        .filter(b => b.serviceType === "core" || (b.services && b.services.some(s => s.type === "core")))
        .reduce((sum, b) => sum + getBookingRevenue(b), 0);
      const repairRevenue = bookings
        .filter(b => b.serviceType === "repair" || (b.services && b.services.some(s => s.type === "repair")))
        .reduce((sum, b) => sum + getBookingRevenue(b), 0);
      
      // Top revenue generating technicians
      const techRevenue = {};
      bookings.forEach(b => {
        if (b.technicianId) {
          const revenue = getBookingRevenue(b);
          if (revenue <= 0) return;
          const techId = b.technicianId.toString();
          if (!techRevenue[techId]) {
            techRevenue[techId] = {
              id: techId,
              name: b.technician?.name || "Unknown",
              revenue: 0,
              bookings: 0,
              completed: 0
            };
          }
          techRevenue[techId].revenue += revenue;
          techRevenue[techId].bookings++;
          if (b.status === "completed") techRevenue[techId].completed++;
        }
      });
      
      const topTechnicians = Object.values(techRevenue)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);
      
      // Payment status breakdown
      const paidBookings = bookings.filter(b => b.paymentStatus === "paid").length;
      const pendingPayments = bookings.filter(b => b.paymentStatus === "pending").length;
      const partialPayments = bookings.filter(b => b.paymentStatus === "partial").length;
      const failedPayments = bookings.filter(b => b.paymentStatus === "failed").length;
      
      // Order status breakdown
      const orderStatusBreakdown = {};
      orders.forEach(o => {
        orderStatusBreakdown[o.status] = (orderStatusBreakdown[o.status] || 0) + 1;
      });
      
      // Recent transactions
      const recentTransactions = [
        ...bookings.map(b => ({
          type: "service",
          id: b._id,
          reference: b.bookingReference,
          customer: b.customer?.name || "Unknown",
          amount: getBookingRevenue(b),
          status: b.paymentStatus,
          method: b.paymentMethod,
          date: b.createdAt
        })),
        ...orders.map(o => ({
          type: "order",
          id: o._id,
          reference: o.orderReference,
          customer: o.customer?.name || "Unknown",
          amount: o.total || o.totalAmount || 0,
          status: o.paymentStatus,
          method: o.paymentMethod,
          date: o.createdAt
        }))
      ]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 15);
      
      // Calculate growth (compare last 30 days to previous 30 days)
      const prev30DaysStart = new Date(thirtyDaysAgo);
      prev30DaysStart.setDate(prev30DaysStart.getDate() - 30);
      
      const current30DaysRevenue = bookings
        .filter(b => new Date(b.createdAt) >= thirtyDaysAgo)
        .reduce((sum, b) => sum + getBookingRevenue(b), 0);
      const prev30DaysRevenue = bookings
        .filter(b => {
          const date = new Date(b.createdAt);
          return date >= prev30DaysStart && date < thirtyDaysAgo;
        })
        .reduce((sum, b) => sum + getBookingRevenue(b), 0);
      
      const growthRate = prev30DaysRevenue > 0 
        ? ((current30DaysRevenue - prev30DaysRevenue) / prev30DaysRevenue) * 100 
        : 0;
      
      // ── Parts Cost (Quotation Parts) & Gross Profit ──
      const ServiceToolUsage = require("../models/ServiceToolUsage");
      
      const toolUsages = await ServiceToolUsage.find({
        usedAt: { $gte: twelveMonthsAgo }
      }).lean();

      // Quotation parts cost: sum of all quotation.parts[].cost * quantity across all bookings
      const quotationPartsCost = bookings.reduce((sum, b) => {
        if (b.quotation && b.quotation.parts && b.quotation.parts.length > 0) {
          const total = b.quotation.parts.reduce((ps, p) => ps + ((p.cost || 0) * (p.quantity || 1)), 0);
          // Only count approved/active quotations (where totalCost > 0)
          if (b.quotation.totalCost > 0) {
            return sum + total;
          }
        }
        return sum;
      }, 0);

      const totalPartsCost = toolUsages.reduce((sum, tu) => sum + (tu.toolCost || 0), 0) + quotationPartsCost;
      const grossProfit = totalRevenue - totalPartsCost;
      const grossProfitMargin = totalRevenue > 0 ? ((grossProfit / totalRevenue) * 100).toFixed(1) : "0.0";
      
      // Monthly parts cost (same bucketing as monthlyRevenue)
      const monthlyPartsCost = {};
      for (let i = 0; i < 12; i++) {
        const monthStart = new Date(now);
        monthStart.setMonth(monthStart.getMonth() - i);
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthEnd = new Date(monthStart);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        
        const monthKey = monthStart.toLocaleString('default', { month: 'short' });
        const toolCost = toolUsages
          .filter(tu => {
            const date = new Date(tu.usedAt);
            return date >= monthStart && date < monthEnd;
          })
          .reduce((sum, tu) => sum + (tu.toolCost || 0), 0);

        // Quotation parts cost for this month
        const monthQuotationPartsCost = bookings
          .filter(b => {
            const date = new Date(b.createdAt);
            return date >= monthStart && date < monthEnd;
          })
          .reduce((sum, b) => {
            if (b.quotation && b.quotation.parts && b.quotation.totalCost > 0) {
              return sum + b.quotation.parts.reduce((ps, p) => ps + ((p.cost || 0) * (p.quantity || 1)), 0);
            }
            return sum;
          }, 0);

        monthlyPartsCost[monthKey] = toolCost + monthQuotationPartsCost;
      }
      
      // Per-booking parts cost map
      const bookingToolCostMap = {};
      toolUsages.forEach(tu => {
        const bid = String(tu.bookingId);
        bookingToolCostMap[bid] = (bookingToolCostMap[bid] || 0) + (tu.toolCost || 0);
      });
      
      // Parts cost by service type (core vs repair)
      let corePartsCost = 0, repairPartsCost = 0;
      bookings.forEach(b => {
        const tc = bookingToolCostMap[String(b._id)] || 0;
        if (tc > 0) {
          const isRepair = b.serviceType === "repair" || (b.services && b.services.some(s => s.type === "repair"));
          if (isRepair) repairPartsCost += tc;
          else corePartsCost += tc;
        }
        // Include quotation parts cost in the correct bucket
        if (b.quotation && b.quotation.parts && b.quotation.totalCost > 0) {
          const qPartsCost = b.quotation.parts.reduce((ps, p) => ps + ((p.cost || 0) * (p.quantity || 1)), 0);
          const isRepair = b.serviceType === "repair" || (b.services && b.services.some(s => s.type === "repair"));
          if (isRepair) repairPartsCost += qPartsCost;
          else corePartsCost += qPartsCost;
        }
      });
      
      // Enhance topTechnicians with parts cost and profit
      topTechnicians.forEach(tech => {
        let techPartsCost = 0;
        bookings.forEach(b => {
          if (b.technicianId && b.technicianId.toString() === tech.id) {
            techPartsCost += bookingToolCostMap[String(b._id)] || 0;
          }
        });
        tech.partsCost = techPartsCost;
        tech.profit = tech.revenue - techPartsCost;
      });
      
      res.render("pages/admin/Reports/RevenueReports", {
        title: "Revenue Reports",
        layout: "layouts/admin",
        analytics: {
          totalRevenue,
          serviceRevenue,
          orderRevenue,
          productRevenue,
          deliveryRevenue,
          installationRevenue,
          paymentRevenue,
          gcashRevenue,
          codRevenue,
          bankRevenue,
          otherRevenue,
          coreRevenue,
          repairRevenue,
          corePartsCost,
          repairPartsCost,
          monthlyRevenue,
          monthlyPartsCost,
          topTechnicians,
          totalPartsCost,
          quotationPartsCost,
          grossProfit,
          grossProfitMargin,
          bookingToolCostMap,
          paidBookings,
          pendingPayments,
          partialPayments,
          failedPayments,
          orderStatusBreakdown,
          totalTransactions: bookings.length + orders.length,
          avgTransactionValue: totalRevenue / ((bookings.length + orders.length) || 1),
          recentTransactions,
          growthRate: growthRate.toFixed(1),
          currentMonthRevenue: current30DaysRevenue
        }
      });
    } catch (err) {
      console.error("Revenue reports error:", err);
      res.render("pages/admin/Reports/RevenueReports", {
        title: "Revenue Reports",
        layout: "layouts/admin",
        analytics: null
      });
    }
  },
);

// Admin - Settings: Scheduling
router.get(
  "/admin/settings/scheduling",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Settings/Scheduling", {
      title: "Scheduling Settings",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/technicians/scheduling",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Technicians/Scheduling", {
      title: "Scheduling Settings",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/settings/system",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Settings/System", {
      title: "System settings",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/settings/fare",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Settings/Fare", {
      title: "Fare Settings",
      layout: "layouts/admin",
    });
  },
);
router.get(
  "/admin/settings/email",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Settings/Email", {
      title: "Email / SMTP",
      layout: "layouts/admin",
    });
  },
);

router.get(
  "/admin/settings/company-location",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Settings/CompanyLocation", {
      title: "Company Location",
      layout: "layouts/admin",
    });
  },
);

router.get(
  "/admin/staff/attendance",
  pageAuth.requireRole("admin"),
  (req, res) => {
    res.render("pages/admin/Staff/Attendance", {
      title: "Staff Attendance",
      layout: "layouts/admin",
    });
  },
);

// Admin - Logs page
router.get("/admin/logs", pageAuth.requireRole("admin"), (req, res) => {
  res.render("pages/admin/logs", {
    title: "System Logs",
    layout: "layouts/admin",
  });
});

// Secretary dashboard
router.get("/secretary", pageAuth.requireRole("secretary"), (req, res) => {
  // Use dedicated layout so CSS is loaded only when needed
  res.render("pages/secretary/secretary-dashboard", {
    title: "Secretary Dashboard",
    layout: "layouts/secretary",
  });
});

// Secretary overview
router.get(
  "/secretary/overview",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Appointments/Overview", {
      title: "Overview",
      layout: "layouts/secretary",
    });
  },
);

// Secretary appointments
router.get(
  "/secretary/appointments",
  pageAuth.requireRole("secretary"),
  async (req, res) => {
    // fetch a batch of bookings server-side so the view can render immediately
    try {
      const BookingService = require("../models/BookingService");
      const bookings = await BookingService.find({})
        .populate("customerId", "firstName lastName email phone")
        .populate("technicianId", "firstName lastName email")
        .populate("serviceId", "name type durationMinutes")
        .sort({ bookingDate: -1, startTime: -1 })
        .limit(200)
        .lean();
      
      // Format bookings for frontend
      const formattedBookings = bookings.map(b => ({
        _id: b._id,
        bookingReference: b.bookingReference,
        customerName: b.customerId ? `${b.customerId.firstName || ''} ${b.customerId.lastName || ''}`.trim() : 'N/A',
        customerEmail: b.customerId?.email || '',
        customerPhone: b.customerId?.phone || '',
        technicianName: b.technicianId ? `${b.technicianId.firstName || ''} ${b.technicianId.lastName || ''}`.trim() : 'N/A',
        serviceName: b.serviceId?.name || 'N/A',
        serviceType: b.serviceId?.type || 'N/A',
        bookingDate: b.bookingDate,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status,
        estimatedFee: b.estimatedFee,
        issueDescription: b.issueDescription,
        address: b.address,
      }));

      res.render("pages/secretary/Appointments/Appointments", {
        title: "Appointments",
        layout: "layouts/secretary",
        initialBookings: formattedBookings,
      });
    } catch (err) {
      console.error("/secretary/appointments failed", err && err.message);
      res.render("pages/secretary/Appointments/Appointments", {
        title: "Appointments",
        layout: "layouts/secretary",
        initialBookings: [],
      });
    }
  },
);

router.get(
  "/secretary/appointments/completed",
  pageAuth.requireRole("secretary"),
  async (req, res) => {
    try {
      const BookingService = require("../models/BookingService");
      const bookings = await BookingService.find({ status: "completed" })
        .populate("customerId", "firstName lastName email phone")
        .populate("technicianId", "firstName lastName email")
        .populate("serviceId", "name type durationMinutes")
        .sort({ bookingDate: -1, startTime: -1 })
        .limit(200)
        .lean();
      
      // Format bookings for frontend
      const formattedBookings = bookings.map(b => ({
        _id: b._id,
        bookingReference: b.bookingReference,
        customerName: b.customerId ? `${b.customerId.firstName || ''} ${b.customerId.lastName || ''}`.trim() : 'N/A',
        customerEmail: b.customerId?.email || '',
        customerPhone: b.customerId?.phone || '',
        technicianName: b.technicianId ? `${b.technicianId.firstName || ''} ${b.technicianId.lastName || ''}`.trim() : 'N/A',
        serviceName: b.serviceId?.name || 'N/A',
        serviceType: b.serviceId?.type || 'N/A',
        bookingDate: b.bookingDate,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status,
        estimatedFee: b.estimatedFee,
        issueDescription: b.issueDescription,
        address: b.address,
      }));

      res.render("pages/secretary/Appointments/Appointments", {
        title: "Completed Appointments",
        layout: "layouts/secretary",
        initialBookings: formattedBookings,
      });
    } catch (err) {
      console.error("/secretary/appointments/completed failed", err && err.message);
      res.render("pages/secretary/Appointments/Appointments", {
        title: "Completed Appointments",
        layout: "layouts/secretary",
        initialBookings: [],
      });
    }
  },
);

router.get(
  "/secretary/appointments/overview",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Appointments/Overview", {
      title: "Appointments Overview",
      layout: "layouts/secretary",
    });
  },
);

router.get(
  "/secretary/calendar",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Appointments/Calendar", {
      title: "Appointments Calendar",
      layout: "layouts/secretary",
    });
  },
);

router.get(
  "/secretary/appointments/booking-requests",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Appointments/BookingRequest", {
      title: "Booking Requests",
      layout: "layouts/secretary",
    });
  },
);

router.get(
  "/secretary/appointments/reschedule",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Appointments/Reschedule", {
      title: "Reschedule Appointment",
      layout: "layouts/secretary",
    });
  },
);

router.get(
  "/secretary/appointments/walk-in",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Appointments/WalkIn", {
      title: "Walk-in Appointment",
      layout: "layouts/secretary",
    });
  },
);

router.get(
  "/secretary/pointofsale",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Appointments/Pointofsale", {
      title: "Point of Sale",
      layout: "layouts/secretary",
    });
  },
);
router.get(
  "/secretary/inventory/repair-parts",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/admin/Inventory/RepairParts", {
      title: "Parts & Tools Catalog",
      layout: "layouts/secretary",
    });
  },
);

// Secretary services (added for dropdown)
router.get(
  "/secretary/services/core",
  pageAuth.requireRole("secretary"),
  async (req, res) => {
    try {
      const coreServices = await CoreService.find({}).lean().limit(200);
      res.render("pages/secretary/Services/Coreservices", {
        title: "Core Services",
        layout: "layouts/secretary",
        coreServices,
      });
    } catch (err) {
      console.error("/secretary/services/core failed", err && err.message);
      res.render("pages/secretary/Services/Coreservices", {
        title: "Core Services",
        layout: "layouts/secretary",
        coreServices: [],
      });
    }
  },
);
router.get(
  "/secretary/services/repair",
  pageAuth.requireRole("secretary"),
  async (req, res) => {
    try {
      const repairServices = await RepairService.find({}).lean().limit(200);
      res.render("pages/secretary/Services/Repairservices", {
        title: "Repair Services",
        layout: "layouts/secretary",
        repairServices,
      });
    } catch (err) {
      console.error("/secretary/services/repair failed", err && err.message);
      res.render("pages/secretary/Services/Repairservices", {
        title: "Repair Services",
        layout: "layouts/secretary",
        repairServices: [],
      });
    }
  },
);

// Secretary inventory routes
router.get(
  "/secretary/inventory",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Inventory/InventoryList", {
      title: "Inventory",
      layout: "layouts/secretary",
    });
  },
);

router.get(
  "/secretary/inventory/deliveries",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Inventory/DeliveryCalendar", {
      title: "Delivery Calendar",
      layout: "layouts/secretary",
    });
  },
);

router.get(
  "/secretary/inventory/ordered-products",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.redirect("/admin/appointments/orders");
  },
);

router.get(
  "/secretary/inventory/history",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Inventory/StockHistory", {
      title: "Stock History",
      layout: "layouts/secretary",
    });
  },
);

// Secretary reports routes


router.get(
  "/secretary/reports/revenue", pageAuth.requireRole("secretary"), async (req, res) => { try { const BookingService = require("../models/BookingService"); const Payment = require("../models/Payment"); const Order = require("../models/Order"); const Technician = require("../models/Technician"); const now = new Date(); const twelveMonthsAgo = new Date(now); twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12); const bookings = await BookingService.find({ createdAt: { $gte: twelveMonthsAgo } }).lean(); const payments = await Payment.find({ submittedAt: { $gte: twelveMonthsAgo }, status: { $in: ["paid", "partial"] } }).lean(); const orders = await Order.find({ createdAt: { $gte: twelveMonthsAgo } }).lean(); function getBookingRev(b) { const isRepair = b.serviceType === "repair" || (b.services && b.services.some(s => s.type === "repair")); if (isRepair) { return (b.inspectionFeeTotalCollected || b.initialCost || 0) + ((b.quotation && b.quotation.totalCost) || 0); } return b.totalPrice || b.estimatedFee || 0; } const serviceRevenue = bookings.reduce((sum, b) => sum + getBookingRev(b), 0); const orderRevenue = orders.reduce((sum, o) => sum + (o.total || o.totalAmount || 0), 0); const totalRevenue = serviceRevenue + orderRevenue; const totalTransactions = bookings.length; const avgTransactionValue = totalTransactions > 0 ? totalRevenue / totalTransactions : 0; const paidBookings = payments.length; const pendingPayments = bookings.filter(b => b.status === "pending" || b.status === "confirmed").length; const gcashRevenue = payments.filter(p => p.paymentMethod === "gcash").reduce((sum, p) => sum + (p.amount || 0), 0); const codRevenue = payments.filter(p => p.paymentMethod === "cod" || p.paymentMethod === "cash").reduce((sum, p) => sum + (p.amount || 0), 0); const coreRevenue = bookings.filter(b => b.serviceType === "core" || (b.services && b.services.some(s => s.type === "core"))).reduce((sum, b) => sum + getBookingRev(b), 0); const repairRevenue = bookings.filter(b => b.serviceType === "repair" || (b.services && b.services.some(s => s.type === "repair"))).reduce((sum, b) => sum + getBookingRev(b), 0); const technicians = await Technician.find({}).lean(); const technicianRevenue = {}; bookings.forEach(b => { if (b.technicianId && b.status === "completed") { technicianRevenue[b.technicianId] = (technicianRevenue[b.technicianId] || 0) + (b.totalPrice || b.estimatedFee || 0); } }); const topTechnicians = Object.entries(technicianRevenue).map(([techId, revenue]) => { const tech = technicians.find(t => t._id.toString() === techId); const techBookings = bookings.filter(b => b.technicianId && b.technicianId.toString() === techId && b.status === "completed"); return { _id: techId, name: tech ? tech.name : "Unknown", revenue, bookings: techBookings.length }; }).sort((a, b) => b.revenue - a.revenue).slice(0, 5); const dailyRevenue = []; for (let i = 0; i < 30; i++) { const date = new Date(now); date.setDate(date.getDate() - i); const dateStr = date.toISOString().split("T")[0]; const dayBookings = bookings.filter(b => new Date(b.createdAt).toISOString().split("T")[0] === dateStr); const dayPayments = payments.filter(p => new Date(p.submittedAt).toISOString().split("T")[0] === dateStr); dailyRevenue.push({ date: dateStr, gross: dayBookings.reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0), net: dayPayments.reduce((sum, p) => sum + (p.amount || 0), 0) }); } dailyRevenue.reverse(); const monthlyRevenue = {}; for (let i = 0; i < 12; i++) { const monthDate = new Date(now); monthDate.setMonth(monthDate.getMonth() - i); const monthKey = monthDate.toLocaleString("en-US", { month: "short", year: "numeric" }); const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1); const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0); const monthBookings = bookings.filter(b => { const bookingDate = new Date(b.createdAt); return bookingDate >= monthStart && bookingDate <= monthEnd; }); const monthOrders = orders.filter(o => { const orderDate = new Date(o.createdAt); return orderDate >= monthStart && orderDate <= monthEnd; }); const monthServiceRevenue = monthBookings.reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0); const monthOrderRevenue = monthOrders.reduce((sum, o) => sum + (o.total || o.totalAmount || 0), 0); monthlyRevenue[monthKey] = { service: monthServiceRevenue, orders: monthOrderRevenue, total: monthServiceRevenue + monthOrderRevenue }; } const monthlyRevenueArray = Object.entries(monthlyRevenue).map(([month, data]) => ({ month, service: data.service, orders: data.orders, total: data.total })).reverse(); const paymentMethods = {}; payments.forEach(p => { const method = p.paymentMethod || "other"; paymentMethods[method] = (paymentMethods[method] || 0) + (p.amount || 0); }); res.render("pages/secretary/Reports/RevenueReports", { title: "Revenue Reports", layout: "layouts/secretary", analytics: { totalRevenue, totalTransactions, serviceRevenue, orderRevenue, avgTransactionValue, paidBookings, pendingPayments, gcashRevenue, codRevenue, coreRevenue, repairRevenue, topTechnicians, dailyRevenue, paymentMethods, monthlyRevenue: monthlyRevenueArray, deliveryRevenue: 0, installationRevenue: 0, bankRevenue: 0, paymentRevenue: gcashRevenue + codRevenue, partialPayments: payments.filter(p => p.status === "partial").length, failedPayments: payments.filter(p => p.status === "failed").length, growthRate: 0 } }); } catch (err) { console.error("Revenue reports error:", err); res.render("pages/secretary/Reports/RevenueReports", { title: "Revenue Reports", layout: "layouts/secretary", analytics: null }); } },
);

router.get(
  "/secretary/reports/service", pageAuth.requireRole("secretary"), async (req, res) => { try { const BookingService = require("../models/BookingService"); const Technician = require("../models/Technician"); const now = new Date(); const ninetyDaysAgo = new Date(now); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90); const bookings = await BookingService.find({ createdAt: { $gte: ninetyDaysAgo } }).lean(); const technicians = await Technician.find({}).lean(); const totalBookings = bookings.length; const completedBookings = bookings.filter(b => b.status === "completed").length; const pendingBookings = bookings.filter(b => ["pending", "confirmed", "scheduled"].includes(b.status)).length; const cancelledBookings = bookings.filter(b => b.status === "cancelled").length; const inProgressBookings = bookings.filter(b => ["on-the-way", "in-progress", "arrived"].includes(b.status)).length; const statusBreakdown = {}; bookings.forEach(b => { statusBreakdown[b.status] = (statusBreakdown[b.status] || 0) + 1; }); const gcashBookings = bookings.filter(b => b.paymentMethod === "gcash").length; const codBookings = bookings.filter(b => b.paymentMethod === "cod").length; const otherPaymentBookings = totalBookings - gcashBookings - codBookings; const coreServiceBookings = bookings.filter(b => b.serviceType === "core" || (b.services && b.services.some(s => s.type === "core"))).length; const repairBookings = bookings.filter(b => b.serviceType === "repair" || (b.services && b.services.some(s => s.type === "repair"))).length; const multiServiceBookings = bookings.filter(b => b.isMultiService).length; const totalRevenue = bookings.reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0); const completedRevenue = bookings.filter(b => b.status === "completed").reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0); const pendingRevenue = bookings.filter(b => ["pending", "confirmed", "scheduled"].includes(b.status)).reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0); const avgBookingValue = totalBookings > 0 ? totalRevenue / totalBookings : 0; const technicianStats = {}; bookings.forEach(b => { if (b.technicianId) { const techId = b.technicianId.toString(); if (!technicianStats[techId]) { technicianStats[techId] = { id: techId, name: b.technician?.name || "Unknown", totalBookings: 0, completedBookings: 0, cancelledBookings: 0, revenue: 0, ratings: [] }; } technicianStats[techId].totalBookings++; technicianStats[techId].revenue += (b.totalPrice || b.estimatedFee || 0); if (b.status === "completed") technicianStats[techId].completedBookings++; if (b.status === "cancelled") technicianStats[techId].cancelledBookings++; if (b.customerRating) technicianStats[techId].ratings.push(b.customerRating); } }); Object.values(technicianStats).forEach(stats => { stats.completionRate = stats.totalBookings > 0 ? (stats.completedBookings / stats.totalBookings) : 0; stats.avgRating = stats.ratings.length > 0 ? (stats.ratings.reduce((a, b) => a + b, 0) / stats.ratings.length) : 0; }); const topTechnicians = Object.values(technicianStats).sort((a, b) => b.revenue - a.revenue).slice(0, 5); const ratedBookings = bookings.filter(b => b.customerRating); const avgRating = ratedBookings.length > 0 ? ratedBookings.reduce((sum, b) => sum + b.customerRating, 0) / ratedBookings.length : 0; const ratingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }; ratedBookings.forEach(b => { if (b.customerRating >= 1 && b.customerRating <= 5) { ratingDistribution[b.customerRating]++; } }); const weeklyData = {}; for (let i = 0; i < 12; i++) { const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - (i * 7)); weekStart.setHours(0, 0, 0, 0); const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7); const weekBookings = bookings.filter(b => { const date = new Date(b.createdAt); return date >= weekStart && date < weekEnd; }); const weekKey = `W${12-i}`; weeklyData[weekKey] = { bookings: weekBookings.length, revenue: weekBookings.reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0), completed: weekBookings.filter(b => b.status === "completed").length }; } const recentBookings = bookings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10).map(b => ({ id: b._id, reference: b.bookingReference, customer: b.customer?.name || "Unknown", service: b.service?.name || b.serviceType || "Unknown", status: b.status, amount: b.totalPrice || b.estimatedFee || 0, date: b.createdAt, technician: b.technician?.name || "Unassigned" })); const dailyTrend = []; for (let i = 6; i >= 0; i--) { const dayStart = new Date(now); dayStart.setDate(dayStart.getDate() - i); dayStart.setHours(0, 0, 0, 0); const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1); const dayBookings = bookings.filter(b => { const d = new Date(b.createdAt); return d >= dayStart && d < dayEnd; }); dailyTrend.push({ day: dayStart.toLocaleDateString("en-US", { weekday: "short" }), date: dayStart.toISOString().slice(0, 10), bookings: dayBookings.length, completed: dayBookings.filter(b => b.status === "completed").length }); } const serviceAggMap = {}; bookings.forEach(b => { const sName = b.service?.name || b.serviceType || "Unknown"; if (!serviceAggMap[sName]) { serviceAggMap[sName] = { name: sName, bookings: 0, completed: 0, revenue: 0, ratings: [] }; } serviceAggMap[sName].bookings++; serviceAggMap[sName].revenue += (b.totalPrice || b.estimatedFee || 0); if (b.status === "completed") serviceAggMap[sName].completed++; if (b.customerRating) serviceAggMap[sName].ratings.push(b.customerRating); }); const topServices = Object.values(serviceAggMap).map(s => ({ ...s, completionRate: s.bookings > 0 ? (s.completed / s.bookings) * 100 : 0, avgRating: s.ratings.length > 0 ? (s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length) : 0, avgRevenue: s.bookings > 0 ? s.revenue / s.bookings : 0 })).sort((a, b) => b.bookings - a.bookings).slice(0, 5); const techUtilization = Object.values(technicianStats).map(t => ({ name: t.name, completed: t.completedBookings, total: t.totalBookings, utilization: t.totalBookings > 0 ? Math.round((t.completedBookings / t.totalBookings) * 100) : 0 })).sort((a, b) => b.utilization - a.utilization).slice(0, 10); const weeklyCsat = []; for (let i = 5; i >= 0; i--) { const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - (i * 7)); weekStart.setHours(0, 0, 0, 0); const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7); const weekRated = bookings.filter(b => { const d = new Date(b.createdAt); return d >= weekStart && d < weekEnd && b.customerRating; }); const avg = weekRated.length > 0 ? weekRated.reduce((s, b) => s + b.customerRating, 0) / weekRated.length : 0; weeklyCsat.push({ week: `W${i + 1}`, avg }); } res.render("pages/secretary/Reports/ServiceReport", { title: "Service Reports", layout: "layouts/secretary", analytics: { totalBookings, completedBookings, pendingBookings, cancelledBookings, inProgressBookings, gcashBookings, codBookings, otherPaymentBookings, coreServiceBookings, repairBookings, multiServiceBookings, totalRevenue, completedRevenue, pendingRevenue, avgBookingValue, avgRating: avgRating.toFixed(1), ratingDistribution, statusBreakdown, technicianStats, topTechnicians, weeklyData, dailyTrend, topServices, techUtilization, weeklyCsat, recentBookings, technicians: technicians.map(t => ({ _id: t._id, name: t.name, email: t.userEmail, specialization: t.specialization, active: t.active })) } }); } catch (err) { console.error("Service reports error:", err); res.render("pages/secretary/Reports/ServiceReport", { title: "Service Reports", layout: "layouts/secretary", analytics: null }); } },
);

router.get(
  "/secretary/reports/inventory",
  pageAuth.requireRole("secretary"),
  async (req, res) => {
    try {
      const Inventory = require("../models/Inventory");
      const Tool = require("../models/Tool");
      const ServiceToolUsage = require("../models/ServiceToolUsage");
      const inventoryItems = await Inventory.find({}).lean();
      const tools = await Tool.find({}).lean();
      const totalProducts = inventoryItems.length;
      const inStock = inventoryItems.filter(i => i.status === "in_stock").length;
      const lowStock = inventoryItems.filter(i => i.status === "low_stock").length;
      const outOfStock = inventoryItems.filter(i => i.status === "out_of_stock").length;
      const discontinued = inventoryItems.filter(i => i.status === "discontinued").length;
      const totalTools = tools.length;
      const toolsInStock = tools.filter(t => t.status === "in_stock").length;
      const toolsLowStock = tools.filter(t => t.status === "low_stock").length;
      const toolsOutOfStock = tools.filter(t => t.status === "out_of_stock").length;
      const inventoryValue = inventoryItems.reduce((sum, i) => sum + (i.sellingPrice * i.quantity || 0), 0);
      const inventoryCost = inventoryItems.reduce((sum, i) => sum + (i.costPrice * i.quantity || 0), 0);
      const toolsValue = tools.reduce((sum, t) => sum + (t.sellingPrice * t.quantity || 0), 0);
      const toolsCost = tools.reduce((sum, t) => sum + (t.costPrice * t.quantity || 0), 0);
      const typeCounts = {};
      const typeValues = {};
      inventoryItems.forEach(i => {
        typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
        typeValues[i.type] = (typeValues[i.type] || 0) + (i.sellingPrice * i.quantity || 0);
      });
      const stockLevels = inventoryItems.map(i => ({
        name: i.modelLine || i.displayLabel || "Unknown",
        quantity: i.quantity,
        minStock: i.minStockLevel,
        status: i.status,
        value: (i.sellingPrice * i.quantity) || 0,
        cost: (i.costPrice * i.quantity) || 0,
        margin: ((i.sellingPrice - i.costPrice) * i.quantity) || 0,
        type: i.type
      })).sort((a, b) => b.value - a.value).slice(0, 15);
      const lowStockAlerts = [
        ...inventoryItems.filter(i => i.status === "low_stock").map(i => ({
          id: i._id,
          name: i.modelLine || i.displayLabel,
          quantity: i.quantity,
          minStock: i.minStockLevel,
          type: "product",
          priority: i.quantity === 0 ? "critical" : (i.quantity <= i.minStockLevel * 0.5 ? "high" : "medium"),
          value: (i.sellingPrice * i.quantity) || 0,
          daysOfStock: Math.round(i.quantity / Math.max(i.minStockLevel / 7, 1))
        })),
        ...tools.filter(t => t.status === "low_stock").map(t => ({
          id: t._id,
          name: t.itemName,
          quantity: t.quantity,
          minStock: t.minStockLevel,
          type: "tool",
          priority: t.quantity === 0 ? "critical" : (t.quantity <= t.minStockLevel * 0.5 ? "high" : "medium"),
          value: (t.sellingPrice * t.quantity) || 0,
          daysOfStock: Math.round(t.quantity / Math.max(t.minStockLevel / 7, 1))
        }))
      ].sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority] || a.quantity - b.quantity;
      });
      const totalItems = totalProducts + totalTools;
      const healthyItems = inStock + toolsInStock;
      const inventoryHealthScore = totalItems > 0 ? Math.round((healthyItems / totalItems) * 100) : 0;
      const profitPotential = (inventoryValue - inventoryCost) + (toolsValue - toolsCost);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const toolUsage = await ServiceToolUsage.find({ usedAt: { $gte: thirtyDaysAgo } }).lean();
      const totalToolUsage = toolUsage.reduce((sum, u) => sum + (u.quantityUsed || 0), 0);
      const toolUsageValue = toolUsage.reduce((sum, u) => sum + ((u.quantityUsed || 0) * (u.unitPrice || 0)), 0);
      const toolUsageMap = {};
      toolUsage.forEach(u => {
        const name = u.itemName || "Unknown";
        toolUsageMap[name] = (toolUsageMap[name] || 0) + (u.quantityUsed || 0);
      });
      const topUsedTools = Object.entries(toolUsageMap).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, quantity]) => ({ name, quantity }));
      const stockTurnover = tools.map(t => {
        const usage = toolUsageMap[t.itemName] || 0;
        return {
          name: t.itemName,
          stock: t.quantity,
          usage30d: usage,
          turnoverRate: t.quantity > 0 ? (usage / t.quantity) : 0,
          status: t.status
        };
      }).sort((a, b) => b.turnoverRate - a.turnoverRate).slice(0, 10);
      res.render("pages/secretary/Reports/InventoryReports", {
        title: "Inventory Reports",
        layout: "layouts/secretary",
        analytics: {
          totalProducts,
          inStock,
          lowStock,
          outOfStock,
          discontinued,
          totalTools,
          toolsInStock,
          toolsLowStock,
          toolsOutOfStock,
          inventoryValue,
          inventoryCost,
          toolsValue,
          toolsCost,
          totalValue: inventoryValue + toolsValue,
          totalCost: inventoryCost + toolsCost,
          typeCounts,
          typeValues,
          stockLevels,
          lowStockAlerts: lowStockAlerts.slice(0, 15),
          profitPotential,
          inventoryHealthScore,
          totalToolUsage,
          toolUsageValue,
          topUsedTools,
          stockTurnover
        }
      });
    } catch (err) {
      console.error("Inventory reports error:", err);
      res.render("pages/secretary/Reports/InventoryReports", {
        title: "Inventory Reports",
        layout: "layouts/secretary",
        analytics: null
      });
    }
  },
);



// Secretary payments routes
router.get(
  "/secretary/payments",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Payments/PaymentsList", {
      title: "Payments",
      layout: "layouts/secretary",
    });
  },
);

router.get(
  "/secretary/payments/pending",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Payments/PendingPayments", {
      title: "Pending Payments",
      layout: "layouts/secretary",
    });
  },
);

router.get(
  "/secretary/payments/completed",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/secretary/Payments/CompletedPayments", {
      title: "Completed Payments",
      layout: "layouts/secretary",
    });
  },
);

// Secretary service tracking
router.get(
  "/secretary/service-tracking",
  pageAuth.requireRole("secretary"),
  (req, res) => {
    res.render("pages/shared/ServiceTracking", {
      title: "Service Tracking",
      layout: "layouts/secretary",
      apiBase: "/api/secretary",
      roleLabel: "Secretary",
    });
  },
);

// ── Public No-Show Reschedule Page ──────────────────────────────────
router.get("/reschedule/no-show/:token", async (req, res) => {
  try {
    const BookingService = require("../models/BookingService");
    const token = req.params.token;
    
    // Find booking with this token
    const booking = await BookingService.findOne({ noShowRescheduleToken: token })
      .populate("service")
      .lean();
      
    if (!booking) {
      return res.render("pages/noShowReschedule", { 
        title: "Reschedule Service", 
        error: "This reschedule link is invalid or has already been used.", 
        booking: null, 
        token: null 
      });
    }
    
    // Check expiry
    if (booking.noShowRescheduleExpiry && new Date() > new Date(booking.noShowRescheduleExpiry)) {
      return res.render("pages/noShowReschedule", { 
        title: "Reschedule Service", 
        error: "This reschedule link has expired. Links are only valid for 72 hours.", 
        booking: null, 
        token: null 
      });
    }

    // Check status
    if (booking.noShowRescheduleStatus !== "pending") {
      return res.render("pages/noShowReschedule", { 
        title: "Reschedule Service", 
        error: `This booking has already been ${booking.noShowRescheduleStatus}.`, 
        booking: null, 
        token: null 
      });
    }

    res.render("pages/noShowReschedule", {
      title: "Reschedule Service",
      booking,
      token,
      error: undefined
    });
  } catch (err) {
    console.error(err);
    res.render("pages/noShowReschedule", { 
      title: "Reschedule Service", 
      error: "An unexpected error occurred.", 
      booking: null, 
      token: null 
    });
  }
});

// API: Confirm Reschedule
router.post("/api/reschedule/no-show/:token", async (req, res) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const { newDate, newTime } = req.body;
    const token = req.params.token;

    const booking = await BookingService.findOne({ noShowRescheduleToken: token });
    if (!booking) return res.status(404).json({ error: "Invalid token" });
    if (booking.noShowRescheduleExpiry && new Date() > new Date(booking.noShowRescheduleExpiry)) {
      return res.status(400).json({ error: "Token expired" });
    }
    if (booking.noShowRescheduleStatus !== "pending") {
      return res.status(400).json({ error: "Booking already processed" });
    }

    // -- Conflict check: ensure new date/time slot is available ----------------
    if (newDate && newTime) {
      const hasConflict = await BookingService.findOne({
        _id: { $ne: booking._id },
        bookingDate: new Date(newDate),
        startTime: newTime,
        status: { $in: ["confirmed", "scheduled", "in-progress", "en-route", "on-the-way"] },
      });
      if (hasConflict) {
        return res.status(409).json({ error: "The selected time slot is already booked. Please choose a different time." });
      }
    }

    // Update booking
    booking.bookingDate = new Date(newDate);
    booking.startTime = newTime;
    booking.selectedTimeLabel = newTime;
    booking.status = "re-scheduled";
    booking.noShowRescheduleStatus = "rescheduled";
    booking.noShowRescheduleToken = undefined; // One-time use
    
    // Push status history
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      status: "re-scheduled",
      message: `Customer rescheduled from No-Show to ${newDate} at ${newTime}`,
      date: new Date(),
      by: "Customer"
    });

    await booking.save();

    // Create a new assignment in pending_acceptance to find a new tech
    await Assignment.create({
      bookingId: booking._id,
      customerName: booking.customer?.name || "Customer",
      serviceName: booking.serviceName || "Service",
      serviceType: booking.serviceType || "core",
      bookingDate: booking.bookingDate,
      startTime: booking.startTime,
      status: "pending_acceptance"
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// API: Cancel Booking
router.post("/api/reschedule/no-show/:token/cancel", async (req, res) => {
  try {
    const BookingService = require("../models/BookingService");
    const token = req.params.token;

    const booking = await BookingService.findOne({ noShowRescheduleToken: token });
    if (!booking) return res.status(404).json({ error: "Invalid token" });
    if (booking.noShowRescheduleExpiry && new Date() > new Date(booking.noShowRescheduleExpiry)) {
      return res.status(400).json({ error: "Token expired" });
    }
    if (booking.noShowRescheduleStatus !== "pending") {
      return res.status(400).json({ error: "Booking already processed" });
    }

    booking.status = "cancelled";
    booking.cancellationReason = "Customer cancelled via No-Show reschedule link.";
    booking.noShowRescheduleStatus = "cancelled";
    booking.noShowRescheduleToken = undefined;

    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      status: "cancelled",
      message: "Customer cancelled their No-Show booking.",
      date: new Date(),
      by: "Customer"
    });

    await booking.save();

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// EXPORT router
module.exports = router;














