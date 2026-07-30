const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const HVACProduct = require("../models/HVACProduct");
const auth = require("../middleware/authenticate");

// Protect all secretary API routes
router.use(auth.authenticate);
router.use(auth.requireRole("secretary"));

// ─── HVAC Product Management (Secretary) ─────────────────────────────────────────────

/**
 * GET /api/secretary/hvac
 * List all HVAC products with variants (read-only for secretary)
 */
router.get("/hvac", async (req, res, next) => {
  try {
    const { page = 1, limit = 10, search, brand, type, inverter } = req.query;
    
    // Build filter
    const filter = { active: true };
    
    if (search) {
      filter.modelLine = new RegExp(search, 'i');
    }
    
    if (brand) {
      filter.brand = brand;
    }
    
    if (type) {
      filter.type = type;
    }
    
    if (inverter !== undefined) {
      filter.inverter = inverter === 'true';
    }
    
    // Execute query with pagination
    const products = await HVACProduct.find(filter)
      .populate('brand', 'name')
      .populate('category', 'name')
      .sort({ modelLine: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();
    
    const total = await HVACProduct.countDocuments(filter);
    
    return res.json({
      products,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit
      }
    });
  } catch (err) {
    console.error("listHVACProducts 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secretary/hvac/:id
 * Get a single HVAC product by ID (read-only for secretary)
 */
router.get("/hvac/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }

    const product = await HVACProduct.findById(id)
      .populate('brand', 'name')
      .populate('category', 'name')
      .lean();

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    return res.json(product);
  } catch (err) {
    console.error("getHVACProduct 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secretary/hvac/brands
 * Get all brands with product counts
 */
router.get("/hvac/brands", async (req, res, next) => {
  try {
    const brands = await HVACProduct.aggregate([
      { $match: { active: true } },
      { $group: { _id: "$brand", count: { $sum: 1 } } },
      { $lookup: { from: "brands", localField: "_id", foreignField: "_id", as: "brandInfo" } },
      { $unwind: "$brandInfo" },
      { $project: { name: "$brandInfo.name", count: 1 } },
      { $sort: { name: 1 } }
    ]);

    return res.json({ brands });
  } catch (err) {
    console.error("getHVACBrands 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secretary/hvac/types
 * Get all product types with counts
 */
router.get("/hvac/types", async (req, res, next) => {
  try {
    const types = await HVACProduct.aggregate([
      { $match: { active: true } },
      { $group: { _id: "$type", count: { $sum: 1 } } },
      { $project: { type: "$_id", count: 1 } },
      { $sort: { type: 1 } }
    ]);

    return res.json({ types });
  } catch (err) {
    console.error("getHVACTypes 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secretary/hvac/summary
 * Get HVAC products summary for dashboard
 */
router.get("/hvac/summary", async (req, res, next) => {
  try {
    const summary = await HVACProduct.aggregate([
      { $match: { active: true } },
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          totalVariants: { $sum: { $size: "$variants" } },
          inverterProducts: { $sum: { $cond: ["$inverter", 1, 0] } },
          totalStock: { $sum: { $sum: "$variants.quantity" } },
          lowStockProducts: {
            $sum: {
              $cond: [
                { $anyElementTrue: {
                  $map: {
                    input: "$variants",
                    as: "variant",
                    in: { $lte: ["$$variant.quantity", "$$variant.minStockLevel"] }
                  }
                }},
                1,
                0
              ]
            }
          },
          outOfStockProducts: {
            $sum: {
              $cond: [
                { $anyElementTrue: {
                  $map: {
                    input: "$variants",
                    as: "variant",
                    in: { $eq: ["$$variant.quantity", 0] }
                  }
                }},
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    const result = summary[0] || {
      totalProducts: 0,
      totalVariants: 0,
      inverterProducts: 0,
      totalStock: 0,
      lowStockProducts: 0,
      outOfStockProducts: 0
    };

    return res.json(result);
  } catch (err) {
    console.error("getHVACSummary 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secretary/hvac/search
 * Search HVAC products by model line, brand, or capacity
 */
router.get("/hvac/search", async (req, res, next) => {
  try {
    const { q: query } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: "Search query is required" });
    }
    
    const regex = new RegExp(query, 'i');
    
    const products = await HVACProduct.find({
      active: true,
      $or: [
        { modelLine: regex },
        { "variants.capacity": regex }
      ]
    })
    .populate('brand', 'name')
    .populate('category', 'name')
    .sort({ modelLine: 1 })
    .limit(20)
    .lean();
    
    return res.json({ products });
  } catch (err) {
    console.error("searchHVACProducts 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secretary/hvac/capacity/:capacity
 * Get products with specific HP capacity
 */
router.get("/hvac/capacity/:capacity", async (req, res, next) => {
  try {
    const { capacity } = req.params;
    
    const products = await HVACProduct.find({
      "variants.capacity": capacity,
      "variants.active": true,
      active: true
    })
    .populate('brand', 'name')
    .populate('category', 'name')
    .sort({ modelLine: 1 })
    .lean();
    
    return res.json({ products });
  } catch (err) {
    console.error("getProductsByCapacity 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/secretary/hvac/brand/:brandId
 * Get products by brand
 */
router.get("/hvac/brand/:brandId", async (req, res, next) => {
  try {
    const { brandId } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      return res.status(400).json({ error: "Invalid brand ID" });
    }
    
    const products = await HVACProduct.find({
      brand: brandId,
      active: true
    })
    .populate('brand', 'name')
    .populate('category', 'name')
    .sort({ modelLine: 1 })
    .lean();
    
    return res.json({ products });
  } catch (err) {
    console.error("getProductsByBrand 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
