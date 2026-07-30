const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const {
  authenticate,
} = require("../middleware/authenticate");

// ── GET /api/notifications ─ Get notifications for current user ──────────────
router.get("/", authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = {
      $or: [{ userId }, { role }],
    };

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments(filter),
      Notification.unreadCount(filter),
    ]);

    res.json({
      notifications,
      total,
      unreadCount,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// ── GET /api/notifications/unread-count ─ Get unread count only ──────────────
router.get("/unread-count", authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;

    const unreadCount = await Notification.unreadCount({
      $or: [{ userId }, { role }],
    });

    res.json({ unreadCount });
  } catch (error) {
    console.error("Error fetching unread count:", error);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// ── GET /api/notifications/counts ─ Get sidebar badge counts ─────────────────
router.get("/counts", authenticate, async (req, res) => {
  try {
    const BookingService = require("../models/BookingService");
    const Expense = require("../models/Expense");
    const LeaveRequest = require("../models/LeaveRequest");

    const [pendingBookings, activeJobs, pendingExpenses, assignmentQueue, escalatedBookings, pendingLeaveRequests, unreadNotifs] =
      await Promise.all([
        BookingService.countDocuments({ status: "pending" }),
        BookingService.countDocuments({
          status: {
            $in: [
              "confirmed",
              "scheduled",
              "on-the-way",
              "arrived",
              "in-progress",
            ],
          },
        }),
        Expense.countDocuments({ status: "pending" }),
        BookingService.countDocuments({
          status: { $in: ["awaiting_assignment", "pending_reassignment"] },
        }),
        BookingService.countDocuments({
          $or: [{ escalated: true }, { reassignmentCount: { $gte: 3 } }],
        }),
        LeaveRequest.countDocuments({ status: "pending" }),
        Notification.unreadCount({
          $or: [{ userId: req.user._id }, { role: req.user.role }],
        }),
      ]);

    res.json({
      pendingBookings,
      activeJobs,
      pendingExpenses,
      assignmentQueue,
      escalatedBookings,
      pendingLeaveRequests,
      unreadNotifications: unreadNotifs,
    });
  } catch (error) {
    console.error("Error fetching counts:", error);
    res.status(500).json({ error: "Failed to fetch counts" });
  }
});

// ── PUT /api/notifications/:id/read ─ Mark one as read ───────────────────────
router.put("/:id/read", authenticate, async (req, res) => {
  try {
    const notif = await Notification.markRead(req.params.id);
    if (!notif) return res.status(404).json({ error: "Notification not found" });
    res.json({ notification: notif });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({ error: "Failed to mark as read" });
  }
});

// ── PUT /api/notifications/read ─ Mark selected as read by IDs ───────────────
router.put("/read", authenticate, async (req, res) => {
  try {
    const ids = req.body.ids || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }
    await Notification.markReadMany(ids, req.user._id, req.user.role);
    res.json({ success: true });
  } catch (error) {
    console.error("Error marking selected as read:", error);
    res.status(500).json({ error: "Failed to mark selected as read" });
  }
});

// ── DELETE /api/notifications/bulk-delete ─ Delete selected by IDs ────────────
router.delete("/bulk-delete", authenticate, async (req, res) => {
  try {
    const ids = req.body.ids || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }
    await Notification.deleteManyByIds(ids, req.user._id, req.user.role);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting selected notifications:", error);
    res.status(500).json({ error: "Failed to delete selected notifications" });
  }
});

// ── PUT /api/notifications/read-all ─ Mark all as read ───────────────────────
router.put("/read-all", authenticate, async (req, res) => {
  try {
    await Notification.markAllRead({
      $or: [{ userId: req.user._id }, { role: req.user.role }],
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Error marking all as read:", error);
    res.status(500).json({ error: "Failed to mark all as read" });
  }
});

// ── DELETE /api/notifications/delete-all ─ Delete all notifications ──────────
router.delete("/delete-all", authenticate, async (req, res) => {
  try {
    await Notification.deleteAll({
      $or: [{ userId: req.user._id }, { role: req.user.role }],
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting all notifications:", error);
    res.status(500).json({ error: "Failed to delete all notifications" });
  }
});

// ── DELETE /api/notifications/:id ─ Delete a notification ────────────────────
router.delete("/:id", authenticate, async (req, res) => {
  try {
    await Notification.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

module.exports = router;
