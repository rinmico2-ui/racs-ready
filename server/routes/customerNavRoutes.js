const express = require("express");
const router = express.Router();
const auth = require("../middleware/authenticate");

const AirconCart = require("../models/AirconCart");
const BookingService = require("../models/BookingService");
const Order = require("../models/Order");
const WarrantyClaim = require("../models/WarrantyClaim");
const ProductReturn = require("../models/ProductReturn");
const MaintenanceSchedule = require("../models/MaintenanceSchedule");

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
const ATTENTION_ORDER_PAYMENT_STATUSES = ["pending", "failed"];

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
const PENDING_MAINTENANCE_RESPONSES = ["none", "remind_later"];

function clamp(value) {
  return value > 99 ? 99 : value;
}

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
      $or: [
        { status: { $in: ATTENTION_BOOKING_STATUSES } },
        { serviceChangeRequests: { $elemMatch: { status: ATTENTION_CHANGE_REQUEST_STATUS } } },
        { "proposedReschedule.status": ATTENTION_PROPOSED_RESCHEDULE_STATUS },
      ],
    });

    // Orders: unpaid or failed-payment orders.
    const orders = await Order.countDocuments({
      userId,
      $or: [
        { status: { $in: ATTENTION_ORDER_STATUSES } },
        { paymentStatus: { $in: ATTENTION_ORDER_PAYMENT_STATUSES } },
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
        status: { $in: PENDING_MAINTENANCE_STATUSES },
        "customerResponse.status": { $in: PENDING_MAINTENANCE_RESPONSES },
      }),
    ]);

    const aftercare = claims + returns + pendingMaintenance;

    res.set("Cache-Control", "no-store, private");
    res.json({
      cart: clamp(Number(cart[0] && cart[0].total) || 0),
      bookings,
      orders,
      aftercare,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
