const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const {
  authenticate,
} = require("../middleware/authenticate");

function inboxFilter(user) {
  return {
    $or: [
      { userId: user._id },
      { userId: null, role: user.role },
    ],
  };
}

// ── GET /api/notifications ─ Get notifications for current user ──────────────
router.get("/", authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = inboxFilter(req.user);

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
    const unreadCount = await Notification.unreadCount(inboxFilter(req.user));

    res.json({ unreadCount });
  } catch (error) {
    console.error("Error fetching unread count:", error);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// ── GET /api/notifications/counts ─ Get sidebar badge counts ─────────────────
router.get("/counts", authenticate, require("../middleware/authenticate").requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const BookingService = require("../models/BookingService");
    const Expense = require("../models/Expense");
    const LeaveRequest = require("../models/LeaveRequest");
    const ActivityLog = require("../models/ActivityLog");
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [pendingBookings, activeJobs, pendingExpenses, assignmentQueue, escalatedBookings, noShowBookings, noShowReviewBookings, attentionRequired, pendingLeaveRequests, unreadNotifs, auditToday] =
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
        BookingService.countDocuments({ status: "no-show" }),
        BookingService.countDocuments({
          $or: [
            { status: "no-show-reported" },
            { status: "no-show", "noShowReport.reviewStatus": { $nin: ["confirmed", "rescheduled", "cancelled"] } },
            { status: "reschedule-required" },
          ],
        }),
        BookingService.countDocuments({
          isProject: { $ne: true },
          $or: [
            { status: { $in: ["pending_reassignment", "re-scheduled", "awaiting_assignment", "no-show-reported", "reschedule-required"] } },
            { status: "no-show", "noShowReport.reviewStatus": { $nin: ["confirmed", "rescheduled", "cancelled"] } },
            { status: "cancelled", updatedAt: { $gte: new Date(Date.now() - 90 * 86400000) } },
            { status: { $in: ["on-the-way", "arrived", "in-progress", "inspection_scheduled", "inspection_in_progress", "repair_scheduled", "repair_in_progress"] }, bookingDate: { $lt: new Date() } },
            { status: { $in: ["confirmed", "scheduled"] }, technicianId: null },
          ],
        }),
        LeaveRequest.countDocuments({ status: "pending" }),
        Notification.unreadCount(inboxFilter(req.user)),
        ActivityLog.countDocuments({ createdAt: { $gte: startOfToday } }),
      ]);

    res.json({
      pendingBookings,
      activeJobs,
      pendingExpenses,
      assignmentQueue,
      escalatedBookings,
      noShowBookings,
      noShowReviewBookings,
      attentionRequired,
      pendingLeaveRequests,
      unreadNotifications: unreadNotifs,
      auditToday,
    });
  } catch (error) {
    console.error("Error fetching counts:", error);
    res.status(500).json({ error: "Failed to fetch counts" });
  }
});

// ── PUT /api/notifications/:id/read ─ Mark one as read ───────────────────────
router.put("/:id/read", authenticate, async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      {
        _id: req.params.id,
        ...inboxFilter(req.user),
      },
      { read: true, readAt: new Date() },
      { returnDocument: "after" },
    );
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
    await Notification.markAllRead(inboxFilter(req.user));
    res.json({ success: true });
  } catch (error) {
    console.error("Error marking all as read:", error);
    res.status(500).json({ error: "Failed to mark all as read" });
  }
});

// ── DELETE /api/notifications/delete-all ─ Delete all notifications ──────────
router.delete("/delete-all", authenticate, async (req, res) => {
  try {
    await Notification.deleteAll(inboxFilter(req.user));
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting all notifications:", error);
    res.status(500).json({ error: "Failed to delete all notifications" });
  }
});

// ── DELETE /api/notifications/:id ─ Delete a notification ────────────────────
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const result = await Notification.deleteOne({
      _id: req.params.id,
      ...inboxFilter(req.user),
    });
    if (!result.deletedCount) {
      return res.status(404).json({ error: "Notification not found" });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

module.exports = router;
