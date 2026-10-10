const express = require("express");
const router = express.Router();
const auth = require("../middleware/authenticate");

const AirconCart = require("../models/AirconCart");
const BookingService = require("../models/BookingService");
const Order = require("../models/Order");
const WarrantyClaim = require("../models/WarrantyClaim");
const ProductReturn = require("../models/ProductReturn");
const MaintenanceSchedule = require("../models/MaintenanceSchedule");
const { manilaDateTime } = require('../utils/bookingDateTime');

// ── Badge rules ─────────────────────────────────────────────────────────────
// Every badge below is derived from a real customer-owned query. A badge is
// only ever shown when the customer has something they actually need to act
// on, so the counts stay meaningful instead of decorative.

// Bookings where the customer has a decision to make: approve/decline a
// repair quotation, pick a replacement slot, or schedule an approved repair.
// These are exactly the states the booking detail modal renders an action for.
const ATTENTION_BOOKING_STATUSES = [
  "awaiting_approval",
  "waiting-for-customer",
  "reschedule-required",
  "repair_approved",
];
// An admin counter-proposal on the service or schedule also needs an answer.
const ATTENTION_CHANGE_REQUEST_STATUS = "schedule_proposed";
// ...as does an unaccepted proposed reschedule.
const ATTENTION_PROPOSED_RESCHEDULE_STATUS = "pending";

// Orders waiting on the customer to pay, or whose payment attempt failed.
const ATTENTION_ORDER_STATUSES = ["pending_payment"];

// A warranty claim stops counting once it reaches an outcome.
const CLOSED_CLAIM_STATUSES = [
  "approved",
  "partially_approved",
  "denied",
  "remedy_in_progress",
  "resolved",
  "closed",
  "withdrawn",
];
// A product return stops counting once it is completed, rejected or cancelled.
const CLOSED_RETURN_STATUSES = ["completed", "rejected", "cancelled"];

// Maintenance cycles that are actually due and still unanswered by the customer.
const PENDING_MAINTENANCE_STATUSES = ["due", "overdue"];

router.use(auth.authenticate);
router.use(auth.requireRole("customer"));

/**
 * GET /api/customer/nav-summary
 * Counts that drive the customer sidebar badges. Deliberately narrow
 * projections and `countDocuments` so the sidebar stays cheap on every page.
 */
router.get("/nav-summary", async (req, res, next) => {
  try {
    const userId = req.user._id;
    const now = new Date();

    // Cart: total units across every line item.
    const cart = await AirconCart.aggregate([
      { $match: { userId } },
      {
        $project: {
          total: {
            $sum: {
              $map: {
                input: { $ifNull: ["$items", []] },
                as: "item",
                in: { $ifNull: ["$$item.quantity", 0] },
              },
            },
          },
        },
      },
    ]);

    // Bookings: anything blocked on the customer.
    const bookings = await BookingService.countDocuments({
      customerId: userId,
      status: { $nin: ['completed', 'cancelled', 'rejected', 'closed'] },
      $or: [
        { status: { $in: ATTENTION_BOOKING_STATUSES } },
        { serviceChangeRequests: { $elemMatch: { status: ATTENTION_CHANGE_REQUEST_STATUS } } },
        { "proposedReschedule.status": ATTENTION_PROPOSED_RESCHEDULE_STATUS,
          "proposedReschedule.date": { $ne: null },
          $or: [{ "proposedReschedule.expiresAt": null }, { "proposedReschedule.expiresAt": { $gt: now } }] },
      ],
    });

    // Orders: unpaid or failed-payment orders.
    const orders = await Order.countDocuments({
      userId,
      status: { $nin: ['completed', 'cancelled'] },
      $or: [
        { status: 'ready_for_pickup' },
        { paymentStatus: { $in: ['failed', 'rejected'] } },
        { status: { $in: ATTENTION_ORDER_STATUSES },
          paymentStatus: { $nin: ['verified', 'paid', 'payment_collected', 'waiting_for_remittance', 'remitted', 'refunded'] },
          gcashProofFileId: null, gcashProofUrl: { $in: [null, ''] } },
      ],
    });

    // Aftercare: unresolved warranty claims, returns, and unanswered maintenance.
    const [claims, returns, pendingMaintenance] = await Promise.all([
      WarrantyClaim.countDocuments({
        customerId: userId,
        status: { $nin: CLOSED_CLAIM_STATUSES },
      }),
      ProductReturn.countDocuments({
        customerId: userId,
        status: { $nin: CLOSED_RETURN_STATUSES },
      }),
      MaintenanceSchedule.countDocuments({
        customerId: userId,
        status: { $in: ['upcoming', ...PENDING_MAINTENANCE_STATUSES] },
        dueDate: { $ne: null, $lt: manilaDateTime(now, 1440) },
        $or: [{ 'customerResponse.status': { $in: ['none', null] } },
          { 'customerResponse.status': 'remind_later', $or: [{ 'customerResponse.remindAt': null }, { 'customerResponse.remindAt': { $lte: now } }] }],
      }),
    ]);

    const aftercare = claims + returns + pendingMaintenance;

    res.set("Cache-Control", "no-store, private");
    res.json({
      cart: Number(cart[0] && cart[0].total) || 0,
      bookings,
      orders,
      aftercare,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
