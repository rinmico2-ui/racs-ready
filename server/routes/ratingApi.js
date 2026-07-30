const express = require("express");
const router = express.Router();
const auth = require("../middleware/authenticate");
const rating = require("../controllers/ratingController");

// only authenticated users may rate
router.use(auth.authenticate);

// inventory rating
router.post("/inventory/:id", rating.rateInventory);
// technician rating (standalone)
router.post("/technician/:id", rating.rateTechnician);
// booking rating (includes technician recalculation)
router.post("/booking/:id", rating.rateBooking);
// order rating (includes technician recalculation)
router.post("/order/:id", rating.rateOrder);

module.exports = router;