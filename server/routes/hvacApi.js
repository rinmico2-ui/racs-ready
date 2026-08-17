const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const HVACProduct = require("../models/HVACProduct");
const Brand = require("../models/Brand");
const Category = require("../models/Category");
const auth = require("../middleware/authenticate");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../public/uploads/hvac");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only images are allowed"));
    }
  },
});

// Protect all admin API routes
router.use(auth.authenticate);
router.use(auth.requireRole("admin"));

// ─── Helper Functions ─────────────────────────────────────────────────────

/**
 * Convert brand string to ObjectId (create if doesn't exist)
 */
async function handleBrand(brandValue) {
  if (!brandValue) return null;
  
  // If it's already a valid ObjectId, return it
  if (mongoose.Types.ObjectId.isValid(brandValue)) {
    return brandValue;
  }
  
  // If it's a string, find or create the brand
  if (typeof brandValue === 'string') {
    const brandName = brandValue.trim();
    let brand = await Brand.findOne({ name: brandName });
    
    if (!brand) {
      brand = new Brand({ name: brandName });
      await brand.save();
    }
    
    return brand._id;
  }
  
  return null;
}

/**
 * Convert category string to ObjectId (create if doesn't exist)
 */
async function handleCategory(categoryValue) {
  if (!categoryValue) return null;
  
  // If it's already a valid ObjectId, return it
  if (mongoose.Types.ObjectId.isValid(categoryValue)) {
    return categoryValue;
  }
  
  // If it's a string, find or create the category
  if (typeof categoryValue === 'string') {
    const categoryName = categoryValue.trim();
    let category = await Category.findOne({ name: categoryName });
    
    if (!category) {
      category = new Category({ name: categoryName });
      await category.save();
    }
    
    return category._id;
  }
  
  return null;
}

// ─── HVAC Product Management ─────────────────────────────────────────────────────

/**
 * GET /api/admin/hvac
 * List all HVAC products with variants
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
 * GET /api/admin/hvac/:id
 * Get a single HVAC product by ID
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
 * POST /api/admin/hvac
 * Create a new HVAC product
 */
router.post("/hvac", upload.single("image"), async (req, res, next) => {
  try {
    let {
      modelLine,
      brand,
      category,
      type,
      inverter,
      description,
      imageUrl,
      specifications,
      salesChannel,
      supplier,
      variants
    } = req.body;

    // Handle uploaded file
    if (req.file) {
      imageUrl = `/uploads/hvac/${req.file.filename}`;
    }

    // Parse JSON strings if this is multipart form data
    if (typeof inverter === 'string') inverter = inverter === 'true';
    if (typeof specifications === 'string') {
      try { specifications = JSON.parse(specifications); } catch(e) {}
    }
    if (typeof variants === 'string') {
      try { variants = JSON.parse(variants); } catch(e) { variants = []; }
    }

    // Handle brand and category conversion
    brand = await handleBrand(brand);
    category = await handleCategory(category);

    // Validation
    if (!modelLine || !brand || !category) {
      return res.status(400).json({ 
        error: "Model line, brand, and category are required" 
      });
    }

    if (!variants || variants.length === 0) {
      return res.status(400).json({ 
        error: "At least one HP variant is required" 
      });
    }

    // Check for duplicate product
    const existingProduct = await HVACProduct.findOne({
      modelLine: modelLine.trim(),
      brand: brand
    });

    if (existingProduct) {
      return res.status(409).json({ 
        error: "Product with this model line and brand already exists" 
      });
    }

    // Create product
    const product = new HVACProduct({
      modelLine: modelLine.trim(),
      brand,
      category,
      type: type || 'split',
      inverter: inverter || false,
      description: description?.trim() || null,
      imageUrl: imageUrl?.trim() || "/images/products/default.png",
      specifications: specifications || {},
      salesChannel: salesChannel || 'both',
      supplier: supplier?.trim() || null,
      variants: variants.map(v => ({
        ...v,
        status: v.quantity > 0 ? 'in_stock' : 'out_of_stock'
      })),
      createdBy: req.user?._id,
      updatedBy: req.user?._id
    });

    await product.save();
    
    // Populate for response
    await product.populate('brand', 'name');
    await product.populate('category', 'name');

    return res.status(201).json({
      message: "HVAC product created successfully",
      product
    });
  } catch (err) {
    console.error("createHVACProduct 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/admin/hvac/:id
 * Update an HVAC product
 */
router.patch("/hvac/:id", upload.single("image"), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }

    const product = await HVACProduct.findById(id);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    let {
      modelLine,
      brand,
      category,
      type,
      inverter,
      description,
      imageUrl,
      specifications,
      salesChannel,
      supplier,
      variants
    } = req.body;

    // Handle uploaded file
    if (req.file) {
      imageUrl = `/uploads/hvac/${req.file.filename}`;
    }

    // Parse JSON strings if this is multipart form data
    if (typeof inverter === 'string') inverter = inverter === 'true';
    if (typeof specifications === 'string') {
      try { specifications = JSON.parse(specifications); } catch(e) {}
    }
    if (typeof variants === 'string') {
      try { variants = JSON.parse(variants); } catch(e) {}
    }

    // Handle brand and category conversion if provided
    if (brand) brand = await handleBrand(brand);
    if (category) category = await handleCategory(category);

    // Update fields
    if (modelLine) product.modelLine = modelLine.trim();
    if (brand) product.brand = brand;
    if (category) product.category = category;
    if (type !== undefined) product.type = type;
    if (inverter !== undefined) product.inverter = inverter;
    if (description !== undefined) product.description = description?.trim() || null;
    if (imageUrl !== undefined) product.imageUrl = imageUrl?.trim() || "/images/products/default.png";
    if (specifications !== undefined) product.specifications = specifications || {};
    if (salesChannel !== undefined) product.salesChannel = salesChannel;
    if (supplier !== undefined) product.supplier = supplier?.trim() || null;
    if (variants && variants.length > 0) {
      product.variants = variants.map(v => ({
        ...v,
        status: v.quantity > 0 ? 'in_stock' : 'out_of_stock'
      }));
    }

    product.updatedBy = req.user?._id;
    await product.save();
    
    // Populate for response
    await product.populate('brand', 'name');
    await product.populate('category', 'name');

    return res.json({
      message: "HVAC product updated successfully",
      product
    });
  } catch (err) {
    console.error("updateHVACProduct 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/hvac/:id/variants
 * Add a new HP variant to an existing HVAC product
 */
router.post("/hvac/:id/variants", async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }

    const product = await HVACProduct.findById(id);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const variantData = req.body.variant || {};
    const { capacity, btu, sellingPrice, costPrice, quantity, minStockLevel } = variantData;

    if (!capacity || sellingPrice === undefined || sellingPrice === null || sellingPrice === '') {
      return res.status(400).json({ error: "Capacity and selling price are required" });
    }

    // Check for duplicate capacity
    if (product.variants.some(v => v.capacity === String(capacity))) {
      return res.status(409).json({ error: "A variant with this capacity already exists" });
    }

    const qty = parseFloat(quantity) || 0;
    const msl = parseFloat(minStockLevel) || 3;

    const newVariant = {
      _id: new mongoose.Types.ObjectId(),
      capacity: String(capacity),
      btu: parseFloat(btu) || 0,
      sellingPrice: parseFloat(sellingPrice) || 0,
      costPrice: parseFloat(costPrice) || 0,
      quantity: qty,
      minStockLevel: msl,
      status: qty > 0 ? (qty <= msl ? 'low_stock' : 'in_stock') : 'out_of_stock',
      active: true
    };

    product.variants.push(newVariant);
    product.updateOverallStatus();
    product.updatedBy = req.user?._id;
    await product.save();

    return res.status(201).json({
      message: "Variant added successfully",
      product
    });
  } catch (err) {
    console.error("createHVACVariant 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/admin/hvac/:id/variants/:variantId
 * Update an existing HP variant
 */
router.patch("/hvac/:id/variants/:variantId", async (req, res, next) => {
  try {
    const { id, variantId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }

    if (!mongoose.Types.ObjectId.isValid(variantId)) {
      return res.status(400).json({ error: "Invalid variant id" });
    }

    const product = await HVACProduct.findById(id);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const variant = product.variants.id(variantId);
    if (!variant) {
      return res.status(404).json({ error: "Variant not found" });
    }

    const variantData = req.body.variant || {};
    const { capacity, btu, sellingPrice, costPrice, quantity, minStockLevel } = variantData;

    if (capacity !== undefined) variant.capacity = String(capacity);
    if (btu !== undefined) variant.btu = parseFloat(btu) || 0;
    if (sellingPrice !== undefined) variant.sellingPrice = parseFloat(sellingPrice) || 0;
    if (costPrice !== undefined) variant.costPrice = parseFloat(costPrice) || 0;
    if (quantity !== undefined) variant.quantity = parseFloat(quantity) || 0;
    if (minStockLevel !== undefined) variant.minStockLevel = parseFloat(minStockLevel) || 3;

    const qty = variant.quantity;
    const msl = variant.minStockLevel;
    variant.status = qty > 0 ? (qty <= msl ? 'low_stock' : 'in_stock') : 'out_of_stock';

    product.updateOverallStatus();
    product.updatedBy = req.user?._id;
    await product.save();

    return res.json({
      message: "Variant updated successfully",
      product
    });
  } catch (err) {
    console.error("updateHVACVariant 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/hvac/:id
 * Archive (soft delete) an HVAC product
 */
router.delete("/hvac/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }

    const product = await HVACProduct.findById(id);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    product.active = false;
    product.updatedBy = req.user?._id;
    await product.save();

    return res.json({ 
      message: "HVAC product archived successfully",
      product 
    });
  } catch (err) {
    console.error("archiveHVACProduct 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/hvac/brands/all
 * Get all active brands
 */
router.get("/hvac/brands/all", async (req, res, next) => {
  try {
    const brands = await Brand.find({ active: true })
      .sort({ name: 1 })
      .lean();
    
    return res.json({ brands });
  } catch (err) {
    console.error("getAllBrands 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/hvac/categories/all
 * Get all active categories
 */
router.get("/hvac/categories/all", async (req, res, next) => {
  try {
    const categories = await Category.find({ active: true })
      .sort({ name: 1 })
      .lean();
    
    return res.json({ categories });
  } catch (err) {
    console.error("getAllCategories 500:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/hvac/brands
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
 * GET /api/admin/hvac/types
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
 * GET /api/admin/hvac/summary
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

module.exports = router;
