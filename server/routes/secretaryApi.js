const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const admin = require("../controllers/adminController");
const auth = require("../middleware/authenticate");
const audit = require("../utils/audit");
const Inventory = require("../models/Inventory");
const SecretaryAttendance = require("../models/SecretaryAttendance");
const SiteSetting = require("../models/SiteSetting");
const { attendanceDay } = require("../utils/attendanceTime");
const {
	listToolUsage,
	summarizeToolUsage,
	createToolUsageEntry,
	updateToolUsageEntry,
	deleteToolUsageEntry,
} = require("../utils/toolUsageManagement");

// only authenticated secretaries should be able to hit these endpoints
router.use(auth.authenticate);
router.use(auth.requireRole("secretary"));

// Secretary timekeeping uses the same rotating QR shown by the administrator,
// but does not inherit technician-only availability, expense, or remittance rules.
router.get("/attendance/status", async (req, res, next) => {
	try {
		const day = attendanceDay();
		const record = await SecretaryAttendance.findOne({
			userId: req.user._id,
			date: day.start,
		}).lean();

		return res.json({
			date: day.key,
			attendanceStatus: record
				? (record.checkOutTime ? "Checked Out" : record.status)
				: "Not Checked In",
			record,
		});
	} catch (error) {
		next(error);
	}
});

router.post("/attendance/scan", async (req, res, next) => {
	try {
		const token = String(req.body.token || "").trim();
		if (!token) return res.status(400).json({ error: "QR token is required." });

		const now = new Date();
		const day = attendanceDay(now);
		const tokenSetting = await SiteSetting.findOne({ key: "attendance_qr_token" }).lean();
		const configuredToken = tokenSetting && tokenSetting.value;
		if (!configuredToken || configuredToken.date !== day.key || configuredToken.token !== token) {
			return res.status(400).json({ error: "This attendance QR code is invalid or expired." });
		}

		const existing = await SecretaryAttendance.findOne({ userId: req.user._id, date: day.start });
		if (existing && existing.checkInTime) {
			return res.status(409).json({ error: "You have already checked in today." });
		}

		const status = now > day.lateCutoff ? "Late" : "Present";
		const record = await SecretaryAttendance.findOneAndUpdate(
			{ userId: req.user._id, date: day.start },
			{
				$set: {
					status,
					checkInTime: now,
					checkOutTime: null,
					qrVerified: true,
					method: "qr_scan",
					token,
					updatedBy: req.user._id,
				},
			},
			{ upsert: true, returnDocument: "after", runValidators: true },
		);

		await audit.logEvent({
			actor: req.user._id,
			target: req.user._id,
			action: "attendance.secretary.checkin",
			module: "secretary",
			req,
			entityId: record._id,
			entityType: "SecretaryAttendance",
			details: { status, checkInTime: now },
		}).catch(() => {});

		return res.json({ message: `Checked in as ${status}.`, attendanceStatus: status, record });
	} catch (error) {
		if (error && error.code === 11000) {
			return res.status(409).json({ error: "Attendance has already been recorded for today." });
		}
		next(error);
	}
});

router.post("/attendance/checkout", async (req, res, next) => {
	try {
		const now = new Date();
		const day = attendanceDay(now);
		const record = await SecretaryAttendance.findOne({ userId: req.user._id, date: day.start });
		if (!record || !record.checkInTime || !["Present", "Late"].includes(record.status)) {
			return res.status(409).json({ error: "Check in before checking out." });
		}
		if (record.checkOutTime) {
			return res.status(409).json({ error: "You have already checked out today." });
		}

		record.checkOutTime = now;
		record.updatedBy = req.user._id;
		await record.save();
		const hoursWorked = Math.round(((now - record.checkInTime) / 3600000) * 100) / 100;

		await audit.logEvent({
			actor: req.user._id,
			target: req.user._id,
			action: "attendance.secretary.checkout",
			module: "secretary",
			req,
			entityId: record._id,
			entityType: "SecretaryAttendance",
			details: { checkOutTime: now, hoursWorked },
		}).catch(() => {});

		return res.json({ message: "Checked out successfully.", hoursWorked, record });
	} catch (error) {
		next(error);
	}
});

router.get("/attendance/history", async (req, res, next) => {
	try {
		const records = await SecretaryAttendance.find({ userId: req.user._id })
			.sort({ date: -1 })
			.limit(90)
			.select("date status checkInTime checkOutTime qrVerified method remarks")
			.lean();
		return res.json({ records, count: records.length });
	} catch (error) {
		next(error);
	}
});

// Dashboard KPI summary (counts used by secretary dashboard)
router.get("/analytics/summary", admin.analyticsSummary);

// Analytics appointments trend data
router.get("/analytics/appointments", async (req, res, next) => {
	try {
		const BookingService = require("../models/BookingService");
		const days = parseInt(req.query.days) || 7;

		const startDate = new Date();
		startDate.setDate(startDate.getDate() - days);

		const bookings = await BookingService.find({
			createdAt: { $gte: startDate }
		}).lean();

		// Group by date
		const dateGroups = {};
		for (let i = 0; i < days; i++) {
			const date = new Date();
			date.setDate(date.getDate() - i);
			const dateStr = date.toISOString().split('T')[0];
			dateGroups[dateStr] = 0;
		}

		bookings.forEach(b => {
			const dateStr = new Date(b.createdAt).toISOString().split('T')[0];
			if (dateGroups.hasOwnProperty(dateStr)) {
				dateGroups[dateStr]++;
			}
		});

		const labels = Object.keys(dateGroups).reverse();
		const series = labels.map(label => dateGroups[label]);

		return res.json({
			labels,
			series
		});
	} catch (err) {
		next(err);
	}
});

// APPOINTMENTS folder functions
router.get("/customers", admin.listCustomers);
router.get("/customers/:id", admin.getCustomer);
router.get("/customers/:id/violations", admin.getCustomerViolations);
router.get("/customers/:id/bookings", admin.getCustomerBookingHistory);
router.patch("/customers/:id", admin.updateCustomer);

// Technicians list for scheduling UI
router.get("/technicians", admin.listTechnicians);
router.get("/technicians/:id/calendar", admin.getTechnicianCalendar);

// Staff list (includes technicians and other staff)
router.get("/staff", admin.listStaff);

// Technician schedules
router.get("/technician-schedules", admin.listTechnicianSchedules);
router.get("/technician-schedules/:technicianId", admin.getTechnicianSchedule);
router.post("/technician-schedules", admin.upsertTechnicianSchedule);

// Non-working days (day-offs) — secretary can add/remove full-day blocked dates
router.get("/dayoffs", admin.listNonWorkingDays);
router.post("/dayoffs", admin.createNonWorkingDay);
router.delete("/dayoffs/:id", admin.deleteNonWorkingDay);

// SERVICES folder functions
// Core service administration
router.get("/core-services", admin.listCoreServices);
router.get("/core-services/:id", admin.getCoreService);
router.post("/core-services", admin.createCoreService);
router.patch("/core-services/:id", admin.editCoreService);

// Repair service administration
router.get("/repair-services", admin.listRepairServices);
router.get("/repair-services/:id", admin.getRepairService);
router.post("/repair-services", admin.createRepairService);
router.patch("/repair-services/:id", admin.editRepairService);

// Service Categories (read-only for secretary)
const ServiceCategory = require("../models/ServiceCategory");
router.get("/service-categories", async (req, res) => {
  try {
    const categories = await ServiceCategory.find({}).sort({ order: 1 }).lean();
    res.json({ success: true, categories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Service Tracking
router.get("/service-tracking", admin.getServiceTracking);
router.get("/service-tracking/:id", admin.getServiceTrackingDetail);
router.get("/service-tracking/:id/export", admin.exportServiceTracking);
router.post("/service-tracking/export", admin.exportAllServiceTracking);

// Service Types for Service Tracking
router.get("/service-types", admin.getServiceTypes);

// REPORTS folder functions
// Tool usage management (secretary)
router.get("/tool-usage", async (req, res, next) => {
	try {
		const result = await listToolUsage(req.query || {}, 200);
		return res.json(result);
	} catch (err) {
		next(err);
	}
});

router.get("/tool-usage/summary", async (req, res, next) => {
	try {
		const summary = await summarizeToolUsage(req.query || {});
		return res.json(summary);
	} catch (err) {
		next(err);
	}
});

router.get("/tool-usage/options", async (req, res, next) => {
	try {
		const BookingService = require("../models/BookingService");
		const Technician = require("../models/Technician");
		const Tool = require("../models/Tool");

		const [bookings, technicians, tools] = await Promise.all([
			BookingService.find({ status: { $ne: "cancelled" } })
				.sort({ bookingDate: -1, startTime: -1 })
				.limit(300)
				.select("_id bookingReference bookingDate startTime customerName customerId technicianId")
				.lean(),
			Technician.find({})
				.sort({ createdAt: -1 })
				.limit(200)
				.select("_id name firstName lastName email")
				.lean(),
			Tool.find({ active: true, isStockItem: true })
				.sort({ itemName: 1 })
				.limit(600)
				.select("_id itemName unit quantity costPrice barcode")
				.lean(),
		]);

		return res.json({ bookings, technicians, tools, inventory: tools });
	} catch (err) {
		next(err);
	}
});

router.post("/tool-usage", async (req, res, next) => {
	try {
		const result = await createToolUsageEntry({
			body: req.body || {},
			actorId: req.user && req.user._id,
			req,
			moduleName: "secretary",
			allowFuelAndToolCostInput: false,
		});
		return res.status(201).json({
			message: "Tool usage recorded",
			usage: result.usage,
			inventory: result.inventory
				? {
						_id: result.inventory._id,
						itemName: result.inventory.itemName,
						unit: result.inventory.unit,
						quantity: result.inventory.quantity,
					}
				: null,
		});
	} catch (err) {
		if (err.status) return res.status(err.status).json({ error: err.message });
		next(err);
	}
});

router.patch("/tool-usage/:usageId", async (req, res, next) => {
	try {
		const usage = await updateToolUsageEntry({
			usageId: req.params.usageId,
			body: req.body || {},
			actorId: req.user && req.user._id,
			req,
			moduleName: "secretary",
			allowFuelAndToolCostPatch: false,
		});
		return res.json({ message: "Tool usage updated", usage });
	} catch (err) {
		if (err.status) return res.status(err.status).json({ error: err.message });
		next(err);
	}
});

router.delete("/tool-usage/:usageId", async (req, res, next) => {
	try {
		const result = await deleteToolUsageEntry({
			usageId: req.params.usageId,
			actorId: req.user && req.user._id,
			req,
			moduleName: "secretary",
		});
		return res.json({ message: "Tool usage deleted and stock restored", ...result });
	} catch (err) {
		if (err.status) return res.status(err.status).json({ error: err.message });
		next(err);
	}
});

// Tool administration (service tools & materials)
router.get("/tools", admin.listTools);
router.get("/tools/:id", admin.getTool);
router.post("/tools", admin.createTool);
router.patch("/tools/:id", admin.editTool);
router.delete("/tools/:id", admin.deleteTool);

// Payments administration
const paymentController = require("../controllers/paymentController");
router.get("/payments", paymentController.listPayments);
router.get("/payments/:id", paymentController.getPayment);
router.post("/payments", paymentController.createPayment);
router.patch("/payments/:id", paymentController.updatePayment);

// Ordered products / purchases administration
router.get("/purchases", admin.listPurchases);
router.get("/purchases/:id", admin.getPurchase);

// INVENTORY folder functions
// Inventory administration (Aircon products only)
router.get("/inventory", admin.listInventory);
router.post("/inventory", admin.createInventory);
router.patch("/inventory/:id", admin.editInventory);
router.delete("/inventory/:id", async (req, res, next) => {
  try {
    const Inventory = require("../models/Inventory");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid inventory id" });
    }

    const item = await Inventory.findById(id);
    if (!item) return res.status(404).json({ error: "Inventory item not found" });

    item.active = false;
    await item.save();

    return res.json({ message: "Aircon product archived", item });
  } catch (err) {
    next(err);
  }
});

// Legacy inventory stock adjustment (keep existing functionality)
router.get("/inventory/legacy", async (req, res, next) => {
	try {
		const q = req.query || {};
		const filter = {};

		if (q.search) {
			const re = new RegExp(String(q.search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
			filter.$or = [{ modelLine: re }, { barcode: re }, { supplier: re }, { displayLabel: re }];
		}
		if (q.active === "true") filter.active = true;
		if (q.active === "false") filter.active = false;
		if (q.category && mongoose.Types.ObjectId.isValid(q.category)) {
			filter.category = q.category;
		}

		const limit = Math.min(Math.max(1, Number(q.limit) || 200), 1000);
		const items = await Inventory.find(filter)
			.sort({ modelLine: 1 })
			.limit(limit)
			.populate("category", "name")
			.lean();

		return res.json({ items, count: items.length });
	} catch (err) {
		next(err);
	}
});

router.patch("/inventory/:id/stock", async (req, res, next) => {
	try {
		const { id } = req.params;
		if (!mongoose.Types.ObjectId.isValid(id)) {
			return res.status(400).json({ error: "Invalid inventory id" });
		}

		const item = await Inventory.findById(id);
		if (!item) return res.status(404).json({ error: "Inventory item not found" });

		const patch = {};

		if (req.body.quantity !== undefined) {
			const quantity = Number(req.body.quantity);
			if (!Number.isFinite(quantity) || quantity < 0) {
				return res.status(400).json({ error: "Quantity must be a non-negative number" });
			}
			patch.quantity = quantity;
		}

		if (req.body.delta !== undefined) {
			const delta = Number(req.body.delta);
			if (!Number.isFinite(delta)) {
				return res.status(400).json({ error: "Delta must be a valid number" });
			}
			const nextQty = Number(item.quantity || 0) + delta;
			if (nextQty < 0) {
				return res.status(409).json({ error: "Stock cannot be negative" });
			}
			patch.quantity = nextQty;
		}

		if (req.body.minStockLevel !== undefined) {
			const minStockLevel = Number(req.body.minStockLevel);
			if (!Number.isFinite(minStockLevel) || minStockLevel < 0) {
				return res.status(400).json({ error: "minStockLevel must be a non-negative number" });
			}
			patch.minStockLevel = minStockLevel;
		}

		if (!Object.keys(patch).length) {
			return res.status(400).json({ error: "No valid stock fields provided" });
		}

		Object.assign(item, patch);
		await item.save();

		await audit.logEvent({
			actor: req.user && req.user._id,
			target: item._id,
			action: "inventory.secretary.update",
			module: "secretary",
			req,
			details: {
				quantity: item.quantity,
				minStockLevel: item.minStockLevel,
			},
		});

		return res.json({ message: "Inventory updated", item });
	} catch (err) {
		next(err);
	}
});

// REPORTS API endpoints
router.get("/reports/service", async (req, res, next) => {
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
		const completedRevenue = bookings.filter(b => b.status === "completed").reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);
		const pendingRevenue = bookings.filter(b => ["pending", "confirmed", "scheduled"].includes(b.status)).reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);
		const avgBookingValue = totalBookings > 0 ? totalRevenue / totalBookings : 0;

		// Technician performance
		const technicianStats = {};
		bookings.forEach(b => {
			if (b.technicianId) {
				if (!technicianStats[b.technicianId]) {
					technicianStats[b.technicianId] = {
						totalBookings: 0,
						completedBookings: 0,
						revenue: 0,
						ratings: []
					};
				}
				technicianStats[b.technicianId].totalBookings++;
				if (b.status === "completed") {
					technicianStats[b.technicianId].completedBookings++;
					technicianStats[b.technicianId].revenue += (b.totalPrice || b.estimatedFee || 0);
				}
				if (b.customerRating) {
					technicianStats[b.technicianId].ratings.push(b.customerRating);
				}
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
			const rating = Math.round(b.customerRating);
			if (rating >= 1 && rating <= 5) {
				ratingDistribution[rating]++;
			}
		});

		// Weekly data for trend chart
		const weeklyData = [];
		for (let i = 6; i >= 0; i--) {
			const weekStart = new Date(now);
			weekStart.setDate(weekStart.getDate() - (i * 7));
			weekStart.setHours(0, 0, 0, 0);
			const weekEnd = new Date(weekStart);
			weekEnd.setDate(weekEnd.getDate() + 7);

			const weekBookings = bookings.filter(b => b.createdAt >= weekStart && b.createdAt < weekEnd);
			weeklyData.push({
				week: weekStart.toLocaleDateString(),
				total: weekBookings.length,
				completed: weekBookings.filter(b => b.status === "completed").length
			});
		}

		// Recent bookings
		const recentBookings = bookings
			.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
			.slice(0, 10)
			.map(b => ({
				_id: b._id,
				bookingReference: b.bookingReference,
				customerName: b.customerName,
				serviceType: b.serviceType,
				status: b.status,
				totalPrice: b.totalPrice || b.estimatedFee,
				createdAt: b.createdAt
			}));

		// Active technicians count
		const activeTechs = technicians.filter(t => t.active).length;

		// Technician bookings mapping
		const technicianBookings = {};
		bookings.forEach(b => {
			if (b.technicianId) {
				technicianBookings[b.technicianId] = (technicianBookings[b.technicianId] || 0) + 1;
			}
		});

		return res.json({
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
				avgRating,
				ratingDistribution,
				statusBreakdown,
				technicianStats,
				topTechnicians,
				technicians,
				technicianBookings,
				recentBookings
			},
			kpis: {
				totalBookings,
				completionRate: totalBookings > 0 ? Math.round((completedBookings / totalBookings) * 100) : 0,
				activeTechs,
				csatScore: avgRating.toFixed(1)
			},
			charts: {
				bookingTrend: {
					data: weeklyData.reduce((acc, w) => {
						acc[w.week] = w.total;
						return acc;
					}, {})
				},
				statusDistribution: {
					completed: completedBookings,
					pending: pendingBookings,
					cancelled: cancelledBookings
				}
			},
			statusBreakdown,
			technicianStats,
			topTechnicians,
			ratingDistribution,
			avgRating,
			recentBookings
		});
	} catch (err) {
		next(err);
	}
});

router.get("/reports/inventory", async (req, res, next) => {
	try {
		const Inventory = require("../models/Inventory");
		const Tool = require("../models/Tool");

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

		// Calculate inventory health score
		const totalItems = totalProducts + totalTools;
		const healthyItems = inStock + toolsInStock;
		const inventoryHealthScore = totalItems > 0 ? Math.round((healthyItems / totalItems) * 100) : 0;

		// Calculate profit potential
		const profitPotential = (inventoryValue - inventoryCost) + (toolsValue - toolsCost);

		return res.json({
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
				profitPotential,
				stockLevels,
				lowStockAlerts,
				typeCounts,
				typeValues
			},
			kpis: {
				totalSkus: totalProducts,
				totalValue: inventoryValue,
				lowStock,
				outOfStock,
				healthScore: inventoryHealthScore
			},
			charts: {
				stockDistribution: [
					inStock,
					lowStock,
					outOfStock,
					discontinued
				],
				valueByCategory: typeValues
			},
			stockLevels,
			lowStockAlerts,
			typeCounts,
			typeValues,
			toolsStats: {
				totalTools,
				toolsInStock,
				toolsLowStock,
				toolsOutOfStock,
				toolsValue
			}
		});
	} catch (err) {
		next(err);
	}
});

router.get("/reports/revenue", async (req, res, next) => {
	try {
		const { buildRevenueAnalytics } = require("../utils/revenueAnalytics");
		const enterpriseRevenueResult = await buildRevenueAnalytics(req.query);
		const enterpriseAnalytics = enterpriseRevenueResult.analytics;
		return res.json({
			analytics: enterpriseAnalytics,
			kpis: {
				bookedValue: enterpriseAnalytics.totalRevenue,
				recognizedRevenue: enterpriseAnalytics.recognizedRevenue,
				grossCollections: enterpriseAnalytics.grossCollections,
				refunds: enterpriseAnalytics.refunds,
				netCollections: enterpriseAnalytics.netCollections,
				outstandingValue: enterpriseAnalytics.outstandingValue,
				operatingProfit: enterpriseAnalytics.operatingProfit,
				collectionEfficiency: enterpriseAnalytics.collectionRate,
			},
			charts: {
				dailyRevenue: enterpriseAnalytics.dailyRevenue,
				monthlyRevenue: enterpriseAnalytics.monthlyRevenue,
				paymentMethods: {
					gcash: enterpriseAnalytics.gcashRevenue,
					cash: enterpriseAnalytics.codRevenue,
					bank: enterpriseAnalytics.bankRevenue,
					other: enterpriseAnalytics.otherRevenue,
				},
			},
		});

		const BookingService = require("../models/BookingService");
		const Payment = require("../models/Payment");

		// Get date range from query params
		const from = req.query.from ? new Date(req.query.from) : new Date(new Date().setDate(new Date().getDate() - 30));
		const to = req.query.to ? new Date(req.query.to) : new Date();

		// Fetch bookings and payments
		const bookings = await BookingService.find({
			createdAt: { $gte: from, $lte: to }
		}).lean();

		const payments = await Payment.find({
			createdAt: { $gte: from, $lte: to }
		}).lean();

		// Calculate revenue metrics
		const grossRevenue = bookings.reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);
		const netRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
		const avgTicket = bookings.length > 0 ? grossRevenue / bookings.length : 0;
		const collectionEfficiency = grossRevenue > 0 ? Math.round((netRevenue / grossRevenue) * 100) : 0;

		// Calculate growth rates (compare with previous period)
		const prevFrom = new Date(from);
		prevFrom.setDate(prevFrom.getDate() - (to - from) / (1000 * 60 * 60 * 24));
		const prevTo = new Date(from);

		const prevBookings = await BookingService.find({
			createdAt: { $gte: prevFrom, $lte: prevTo }
		}).lean();

		const prevPayments = await Payment.find({
			createdAt: { $gte: prevFrom, $lte: prevTo }
		}).lean();

		const prevGrossRevenue = prevBookings.reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);
		const prevNetRevenue = prevPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
		const prevAvgTicket = prevBookings.length > 0 ? prevGrossRevenue / prevBookings.length : 0;
		const prevCollectionEfficiency = prevGrossRevenue > 0 ? Math.round((prevNetRevenue / prevGrossRevenue) * 100) : 0;

		// Calculate growth percentages
		const grossGrowth = prevGrossRevenue > 0 ? ((grossRevenue - prevGrossRevenue) / prevGrossRevenue * 100).toFixed(1) : 0;
		const netGrowth = prevNetRevenue > 0 ? ((netRevenue - prevNetRevenue) / prevNetRevenue * 100).toFixed(1) : 0;
		const ticketGrowth = prevAvgTicket > 0 ? ((avgTicket - prevAvgTicket) / prevAvgTicket * 100).toFixed(1) : 0;
		const efficiencyGrowth = prevCollectionEfficiency > 0 ? ((collectionEfficiency - prevCollectionEfficiency) / prevCollectionEfficiency * 100).toFixed(1) : 0;

		// Daily revenue trend
		const dailyRevenue = [];
		for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
			const dayStart = new Date(d);
			dayStart.setHours(0, 0, 0, 0);
			const dayEnd = new Date(d);
			dayEnd.setHours(23, 59, 59, 999);

			const dayBookings = bookings.filter(b => b.createdAt >= dayStart && b.createdAt <= dayEnd);
			const dayPayments = payments.filter(p => p.createdAt >= dayStart && p.createdAt <= dayEnd);

			dailyRevenue.push({
				date: dayStart.toISOString().split('T')[0],
				gross: dayBookings.reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0),
				net: dayPayments.reduce((sum, p) => sum + (p.amount || 0), 0)
			});
		}

		// Payment method breakdown
		const paymentMethods = {};
		payments.forEach(p => {
			const method = p.paymentMethod || "other";
			paymentMethods[method] = (paymentMethods[method] || 0) + (p.amount || 0);
		});

		// Calculate additional analytics
		const totalRevenue = grossRevenue;
		const totalTransactions = bookings.length;
		const serviceRevenue = bookings.filter(b => b.serviceType !== 'sales' && !b.isProductSale).reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);
		const orderRevenue = bookings.filter(b => b.serviceType === 'sales' || b.isProductSale).reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);
		const avgTransactionValue = avgTicket;
		const paidBookings = payments.length;
		const pendingPayments = bookings.filter(b => b.status === 'pending' || b.status === 'confirmed').length;
		const gcashRevenue = paymentMethods.gcash || 0;
		const codRevenue = paymentMethods.cod || paymentMethods.cash || 0;
		const coreRevenue = bookings.filter(b => b.serviceType === 'core' || (b.services && b.services.some(s => s.type === 'core'))).reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);
		const repairRevenue = bookings.filter(b => b.serviceType === 'repair' || (b.services && b.services.some(s => s.type === 'repair'))).reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0);

		// Top technicians by revenue
		const technicianRevenue = {};
		bookings.forEach(b => {
			if (b.technicianId && b.status === 'completed') {
				technicianRevenue[b.technicianId] = (technicianRevenue[b.technicianId] || 0) + (b.totalPrice || b.estimatedFee || 0);
			}
		});
		const topTechnicians = Object.entries(technicianRevenue)
			.map(([techId, revenue]) => {
				const tech = technicians.find(t => t._id.toString() === techId);
				const techBookings = bookings.filter(b => b.technicianId && b.technicianId.toString() === techId && b.status === 'completed');
				return {
					_id: techId,
					name: tech ? tech.name : 'Unknown',
					revenue,
					bookings: techBookings.length
				};
			})
			.sort((a, b) => b.revenue - a.revenue)
			.slice(0, 5);

		return res.json({
			analytics: {
				totalRevenue,
				totalTransactions,
				serviceRevenue,
				orderRevenue,
				avgTransactionValue,
				paidBookings,
				pendingPayments,
				gcashRevenue,
				codRevenue,
				coreRevenue,
				repairRevenue,
				topTechnicians,
				dailyRevenue,
				paymentMethods
			},
			kpis: {
				grossRevenue,
				grossGrowth,
				netRevenue,
				netGrowth,
				avgTicket,
				ticketGrowth,
				collectionEfficiency,
				efficiencyGrowth
			},
			charts: {
				monthlyTrend: dailyRevenue.map(d => d.gross),
				expectedTrend: dailyRevenue.map(d => d.net),
				revenueBySegment: {
					sales: bookings.filter(b => b.serviceType === 'sales' || b.isProductSale).reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0),
					service: bookings.filter(b => b.serviceType !== 'sales' && !b.isProductSale).reduce((sum, b) => sum + (b.totalPrice || b.estimatedFee || 0), 0)
				},
				paymentMethods: {
					gcash: paymentMethods.gcash || 0,
					cash: paymentMethods.cod || paymentMethods.cash || 0,
					card: paymentMethods.card || 0,
					maya: paymentMethods.maya || 0
				}
			}
		});
	} catch (err) {
		next(err);
	}
});

module.exports = router;
