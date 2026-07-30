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

    // record individual rating for history
    const Rating = require("../models/Rating");
    await Rating.create({
      customerId: req.user && req.user._id,
      targetType: "inventory",
      targetId: id,
      score,
      comment,
    });

    return res.json({ success: true, score });
  } catch (err) {
    next(err);
  }
};

exports.rateTechnician = async (req, res, next) => {
  try {
    const id = req.params.id;
    const score = Number(req.body.score);
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid technician id" });
    if (!Number.isFinite(score) || score < 1 || score > 5)
      return res.status(400).json({ error: "score must be between 1 and 5" });

    const Technician = require("../models/Technician");
    const tech = await Technician.findById(id);
    if (!tech) return res.status(404).json({ error: "not found" });

    const oldCount = tech.ratingCount || 0;
    const oldTotal = (tech.rating || 0) * oldCount;
    const newCount = oldCount + 1;
    const newAvg = (oldTotal + score) / newCount;
    tech.rating = newAvg;
    tech.ratingCount = newCount;
    await tech.save();

    const Rating = require("../models/Rating");
    await Rating.create({
      customerId: req.user && req.user._id,
      targetType: "technician",
      targetId: id,
      score,
      comment: null,
    });

    return res.json({ rating: tech.rating, ratingCount: tech.ratingCount });
  } catch (err) {
    next(err);
  }
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
    const isUpdate = !!booking.customerRating;

    // Use findByIdAndUpdate to avoid triggering heavy pre-save hooks
    await BookingService.findByIdAndUpdate(id, {
      $set: { customerRating: score, customerRatingComment: comment },
    });

    if (booking.technicianId) {
      await recalcTechnicianRating(booking.technicianId);
    }
    const Rating = require("../models/Rating");
    if (isUpdate) {
      await Rating.findOneAndUpdate(
        { customerId: req.user && req.user._id, targetType: "booking", targetId: id },
        { score, comment },
        { new: true }
      );
    } else {
      await Rating.create({
        customerId: req.user && req.user._id,
        targetType: "booking",
        targetId: id,
        score,
        comment,
      });
    }
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

    order.customerRating = score;
    order.customerRatingComment = comment;
    await order.save();

    if (order.technicianId) {
      await recalcTechnicianRating(order.technicianId);
    }
    
    const Rating = require("../models/Rating");
    await Rating.create({
      customerId: req.user && req.user._id,
      targetType: "order",
      targetId: id,
      score,
      comment,
    });
    
    return res.json({ order });
  } catch (err) {
    next(err);
  }
};
