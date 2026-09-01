const mongoose = require("mongoose");

// helper to update tech average from bookings
async function recalcTechnicianRating(techId) {
  if (!mongoose.Types.ObjectId.isValid(techId)) return;
  const BookingService = require("../models/BookingService");
  const Technician = require("../models/Technician");

  const stats = await BookingService.aggregate([
    { $match: { technicianId: new mongoose.Types.ObjectId(techId), customerRating: { $exists: true, $ne: null } } },
    { $group: { _id: "$technicianId", avg: { $avg: "$customerRating" }, count: { $sum: 1 } } },
  ]);
  if (stats && stats.length) {
    await Technician.findByIdAndUpdate(techId, {
      rating: stats[0].avg,
      ratingCount: stats[0].count,
    });
  }
}

exports.rateInventory = async (req, res, next) => {
  try {
    const id = req.params.id;
    const score = Number(req.body.score);
    const comment = req.body.comment || null;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid inventory id" });
    if (!Number.isFinite(score) || score < 1 || score > 5)
      return res.status(400).json({ error: "score must be between 1 and 5" });

    const Inventory = require("../models/Inventory");
    const item = await Inventory.findById(id);
    if (!item) return res.status(404).json({ error: "not found" });

    const Order = require("../models/Order");
    const purchased = await Order.exists({
      userId: req.user._id,
      status: "completed",
      "items.inventoryId": item._id,
    });
    if (!purchased) {
      return res.status(403).json({ error: "Only verified purchasers can rate this item" });
    }

    // record individual rating for history
    const Rating = require("../models/Rating");
    await Rating.findOneAndUpdate(
      { customerId: req.user._id, targetType: "inventory", targetId: id },
      { $set: { score, comment: comment ? String(comment).slice(0, 1000) : null } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );

    return res.json({ success: true, score });
  } catch (err) {
    next(err);
  }
};

exports.rateTechnician = async (req, res, next) => {
  return res.status(410).json({
    error: "Rate the completed booking or order associated with this technician",
  });
};

// rate a specific booking and optionally update technician average
exports.rateBooking = async (req, res, next) => {
  try {
    const id = req.params.id;
    const score = Number(req.body.score);
    const comment = req.body.comment || null;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid booking id" });
    if (!Number.isFinite(score) || score < 1 || score > 5)
      return res.status(400).json({ error: "score must be between 1 and 5" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "not found" });
    if (String(booking.customerId || "") !== String(req.user._id)) {
      return res.status(403).json({ error: "You can only rate your own booking" });
    }
    if (!["completed", "repair_completed", "closed"].includes(booking.status)) {
      return res.status(409).json({ error: "Only completed bookings can be rated" });
    }
    const isUpdate = !!booking.customerRating;

    // Use findByIdAndUpdate to avoid triggering heavy pre-save hooks
    await BookingService.findByIdAndUpdate(id, {
      $set: { customerRating: score, customerRatingComment: comment ? String(comment).slice(0, 1000) : null },
    });

    if (booking.technicianId) {
      await recalcTechnicianRating(booking.technicianId);
    }
    const Rating = require("../models/Rating");
    await Rating.findOneAndUpdate(
      { customerId: req.user._id, targetType: "booking", targetId: id },
      { $set: { score, comment: comment ? String(comment).slice(0, 1000) : null } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
    return res.json({ success: true, score, updated: isUpdate });
  } catch (err) {
    next(err);
  }
};

// rate a specific order and optionally update technician average
exports.rateOrder = async (req, res, next) => {
  try {
    const id = req.params.id;
    const score = Number(req.body.score);
    const comment = req.body.comment || null;
    
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid order id" });
    if (!Number.isFinite(score) || score < 1 || score > 5)
      return res.status(400).json({ error: "score must be between 1 and 5" });

    const Order = require("../models/Order");
    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ error: "not found" });
    if (String(order.userId || "") !== String(req.user._id)) {
      return res.status(403).json({ error: "You can only rate your own order" });
    }
    if (order.status !== "completed") {
      return res.status(409).json({ error: "Only completed orders can be rated" });
    }

    order.customerRating = score;
    order.customerRatingComment = comment ? String(comment).slice(0, 1000) : null;
    await order.save();

    if (order.technicianId) {
      await recalcTechnicianRating(order.technicianId);
    }
    
    const Rating = require("../models/Rating");
    await Rating.findOneAndUpdate(
      { customerId: req.user._id, targetType: "order", targetId: id },
      { $set: { score, comment: comment ? String(comment).slice(0, 1000) : null } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
    
    return res.json({ order });
  } catch (err) {
    next(err);
  }
};
