const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const HVACProduct = require("../models/HVACProduct");
const { normalizeHvacPrices } = require("../utils/hvacPricing");
const Brand = require("../models/Brand");
const Category = require("../models/Category");
const auth = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { imageExtensionFor, isAllowedImage } = require("../utils/uploadSecurity");
const {
  deleteProductImage,
  isCloudinaryConfigured,
  uploadProductImage,
} = require("../utils/productImageStorage");
const { escapeRegex } = require("../utils/stringSecurity");
const audit = require("../utils/audit");
const { normalizeLifecycleReason, archiveRecord, restoreRecord } = require("../utils/dataLifecycle");
const {
  normalizeProductVariantSerialNumbers,
  normalizeVariantSerialNumbers,
} = require("../utils/hvacSerialNumbers");

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../public/uploads/hvac");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer storage
const localStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + imageExtensionFor(file));
  },
});
const storage = isCloudinaryConfigured() ? multer.memoryStorage() : localStorage;

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (isAllowedImage(file)) {
      cb(null, true);
    } else {
      cb(new Error("Only images are allowed"));
    }
  },
});

function productImageUpload(req, res, next) {
  upload.single("image")(req, res, (error) => {
    if (!error) return next();
    const message = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
      ? "Product images must be 5MB or smaller."
      : error.message || "The product image could not be uploaded.";
    return res.status(400).json({ error: message });
  });
}

// Shared HVAC inventory API. RBAC middleware separately enforces
// inventory.view versus inventory.manage for secretary requests.
router.use(auth.authenticate);
router.use(auth.requireRole(["admin", "secretary"]));
router.use((req, res, next) => {
  if (req.user.role === "admin") return next();
  const permission = ["GET", "HEAD", "OPTIONS"].includes(req.method)
    ? "inventory.view"
    : "inventory.manage";
  return requirePermission(permission)(req, res, next);
});

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
    let brand;
    try {
      brand = await Brand.findOneAndUpdate({ name: brandName }, { $setOnInsert: { name: brandName, active: true } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      brand = await Brand.findOne({ name: brandName });
      if (!brand) throw error;
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
    let category;
    try {
      category = await Category.findOneAndUpdate({ name: categoryName }, { $setOnInsert: { name: categoryName, active: true } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      category = await Category.findOne({ name: categoryName });
      if (!category) throw error;
    }
    return category._id;
  }
  
  return null;
}

async function assertSerialNumbersAvailable(variants, excludedProductId = null) {
  const serialNumbers = (variants || []).flatMap(
    (variant) => variant.serialNumbers || [],
  );
  if (!serialNumbers.length) return;
  const filter = { "variants.serialNumbers": { $in: serialNumbers } };
  if (excludedProductId) filter._id = { $ne: excludedProductId };
  const duplicateProduct = await HVACProduct.findOne(filter)
    .select("variants.serialNumbers")
    .lean();
  if (!duplicateProduct) return;
  const used = new Set(
    (duplicateProduct.variants || []).flatMap((variant) => variant.serialNumbers || []),
  );
  const duplicate = serialNumbers.find((serialNumber) => used.has(serialNumber));
  throw Object.assign(
    new Error(`Serial number ${duplicate || "entered"} is already assigned to another aircon.`),
    { status: 409, code: "HVAC_SERIAL_ALREADY_ASSIGNED" },
  );
}

function duplicateInventoryError(err) {
  if (!err || err.code !== 11000) return null;
  const keyPattern = err.keyPattern || {};
  const duplicatePath = Object.keys(keyPattern)[0] || "";
  const indexHint = `${err.message || ""} ${err.index || ""}`;
  const value = err.keyValue && duplicatePath
    ? err.keyValue[duplicatePath]
    : undefined;
  const suffix = value !== undefined && value !== null && String(value) !== "undefined"
    ? ` "${String(value)}"`
    : "";

  if (duplicatePath === "variants.serialNumbers" || /variants\.serialNumbers/i.test(indexHint)) {
    return {
      error: `Serial number${suffix} is already assigned to another aircon.`,
      code: "HVAC_SERIAL_ALREADY_ASSIGNED",
    };
  }
  if (duplicatePath === "variants.sku" || /variants\.sku/i.test(indexHint)) {
    return { error: `SKU${suffix} is already assigned to another aircon.`, code: "HVAC_SKU_ALREADY_ASSIGNED" };
  }
  if (duplicatePath === "variants.barcode" || /variants\.barcode/i.test(indexHint)) {
    return { error: `Barcode${suffix} is already assigned to another aircon.`, code: "HVAC_BARCODE_ALREADY_ASSIGNED" };
  }
  return {
    error: "An aircon with the same unique inventory value already exists.",
    code: "HVAC_DUPLICATE_VALUE",
  };
}

function sendInventoryError(res, err) {
  const duplicate = duplicateInventoryError(err);
  return res.status(err.status || (duplicate ? 409 : 500)).json({
    error: duplicate?.error || err.message,
    ...(duplicate?.code || err.code ? { code: duplicate?.code || err.code } : {}),
  });
}

// ─── HVAC Product Management ─────────────────────────────────────────────────────

/**
 * GET /api/admin/hvac
 * List all HVAC products with variants
 */
router.get("/hvac", async (req, res, next) => {
  try {
    const { page = 1, limit = 10, search, brand, type, inverter, lifecycle } = req.query;
    
    // Build filter
    const filter = lifecycle === "archived"
      ? { active: false }
      : lifecycle === "all" ? {} : { active: true };
    
    if (search) {
      const searchPattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { modelLine: searchPattern },
        { "variants.sku": searchPattern },
        { "variants.serialNumbers": searchPattern },
      ];
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
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1, fields: 2 } }).single('csv');
function csvFile(req, res, next) {
  csvUpload(req, res, error => {
    if (error) return res.status(400).json({ error: 'Choose one CSV file up to 1 MB.' });
    if (!req.file || !/\.csv$/i.test(req.file.originalname)) return res.status(400).json({ error: 'Choose a CSV file using the inventory template.' });
    next();
  });
}
async function reviewInventoryImport(buffer) {
  const plan = await require('../utils/inventoryCsv').parseInventoryCsv(buffer);
  const brands = new Map(), categories = new Map();
  function lookup(model, cache, value) {
    const key = value.toLowerCase();
    if (!cache.has(key)) {
      const query = mongoose.isObjectIdOrHexString(value) ? model.findById(value).lean() : model.findOne({ name: { $regex: '^' + escapeRegex(value) + '$', $options: 'i' } }).lean();
      // Share the result promise: awaiting a Mongoose Query twice executes it twice.
      cache.set(key, Promise.resolve(query));
    }
    return cache.get(key);
  }
  await require('../utils/bulkPayrollPolicy').mapLimited(plan.products, async product => {
    try {
      const [brand, category] = await Promise.all([lookup(Brand, brands, product.brand), lookup(Category, categories, product.category)]);
      if (mongoose.isObjectIdOrHexString(product.brand) && !brand) throw new Error('Brand not found. Use a valid brand name.');
      if (mongoose.isObjectIdOrHexString(product.category) && !category) throw new Error('Category not found. Use a valid category name.');
      if (brand?.active === false || category?.active === false) throw new Error('Choose an active brand and category.');
      if (brand) product.brand = brand.name;
      if (category) product.category = category.name;
      if (brand && await HVACProduct.exists({ brand: brand._id, modelLine: { $regex: '^' + escapeRegex(product.modelLine) + '$', $options: 'i' } })) throw new Error('This model and brand already exist. Edit the existing product to adjust stock.');
      product.variants = product.variants.map(normalizeHvacPrices);
      const document = new HVACProduct({ ...product, brand: brand?._id || new mongoose.Types.ObjectId(), category: category?._id || new mongoose.Types.ObjectId(), variants: product.variants.map(v => ({ ...v, status: v.quantity > 0 ? 'in_stock' : 'out_of_stock' })) });
      await document.validate();
      await assertSerialNumbersAvailable(product.variants);
      const identifiers = product.variants.flatMap(v => [v.sku ? { 'variants.sku': v.sku } : null, v.barcode ? { 'variants.barcode': v.barcode } : null].filter(Boolean));
      if (identifiers.length && await HVACProduct.exists({ $or: identifiers })) throw new Error('A SKU or barcode in this product is already assigned to another product.');
    } catch (error) { plan.errors.push({ row: product.rows[0], error: error.message }); }
  });
  plan.errors.sort((a, b) => a.row - b.row);
  return plan;
}
router.get('/hvac/import/template', (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="aircon-import-template.csv"');
  res.send(require('../utils/inventoryCsv').csvTemplate());
});
router.post('/hvac/import/preview', csvFile, async (req, res) => {
  try {
    const plan = await reviewInventoryImport(req.file.buffer);
    const previewToken = plan.errors.length ? null : require('jsonwebtoken').sign({ purpose: 'inventory-import', actor: String(req.user._id), hash: plan.hash }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.json({ previewToken, rowCount: plan.rowCount, products: plan.products.map(p => ({ modelLine: p.modelLine, brand: p.brand, category: p.category, variants: p.variants.length })), errors: plan.errors });
  } catch (error) { res.status(error.status || 503).json({ error: error.status === 400 ? error.message : 'The inventory file could not be checked. Please try again.' }); }
});
router.post('/hvac/import/commit', csvFile, async (req, res) => {
  try {
    let certificate;
    try { certificate = require('jsonwebtoken').verify(req.body.previewToken, process.env.JWT_SECRET); }
    catch (_) { return res.status(409).json({ error: 'Review the CSV again before importing. The preview has expired.' }); }
    const hash = require('crypto').createHash('sha256').update(req.file.buffer).digest('hex');
    if (certificate.purpose !== 'inventory-import' || certificate.actor !== String(req.user._id) || certificate.hash !== hash) return res.status(409).json({ error: 'The file changed after review. Review it again before importing.' });
    await require('../utils/operationLock').withOperationLock('inventory-csv-import', async () => {
      const plan = await reviewInventoryImport(req.file.buffer);
      if (plan.errors.length) return res.status(409).json({ error: 'Inventory changed after review. Correct the file and review it again.', errors: plan.errors });
      const results = await require('../utils/bulkPayrollPolicy').mapLimited(plan.products, async product => {
        const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
        await createHVACProduct({ body: product, user: req.user, file: null }, response, { populateResponse: false });
        return { modelLine: product.modelLine, variants: product.variants.length, productId: response.body?.product?._id, success: response.code < 400, error: response.body?.error, message: response.code < 400 ? 'Imported' : undefined };
      });
      const created = results.filter(r => r.success).length;
      await audit.logEvent({ actor: req.user._id, action: 'inventory.csv_imported', module: 'inventory', req, details: { created, failed: results.length - created, rows: plan.rowCount } });
      res.json({ results, created, failed: results.length - created });
    }, { leaseMs: 180000, waitMs: 1000 });
  } catch (error) { res.status(error.status || 503).json({ error: error.code === 'OPERATION_LOCK_TIMEOUT' ? 'Another inventory import is in progress. Try again shortly.' : 'The import could not finish. Refresh inventory to check which products were created before retrying.' }); }
});

router.get("/hvac/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Let static routes such as /hvac/brands/all continue matching below.
    if (!mongoose.Types.ObjectId.isValid(id)) return next("route");

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
async function createHVACProduct(req, res, { populateResponse = true } = {}) {
  let uploadedImage = null;
  try {
    let {
      modelLine,
      brand,
      category,
      type,
      inverter,
      status,
      warranty,
      description,
      imageUrl,
      specifications,
      salesChannel,
      supplier,
      variants
    } = req.body;

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

    variants = normalizeProductVariantSerialNumbers(variants.map(normalizeHvacPrices));
    await assertSerialNumbersAvailable(variants);

    if (req.file) {
      uploadedImage = await uploadProductImage(req.file);
      imageUrl = uploadedImage.imageUrl;
    }

    // Create product
    const productSpecifications = specifications || {};
    if (warranty !== undefined) {
      productSpecifications.warranty = String(warranty).trim() || "1 Year Compressor, 1 Year Parts";
    }

    const product = new HVACProduct({
      modelLine: modelLine.trim(),
      brand,
      category,
      type: type || 'split',
      inverter: inverter || false,
      description: description?.trim() || null,
      imageUrl: imageUrl?.trim() || "/images/products/default.png",
      imagePublicId: uploadedImage?.imagePublicId || null,
      specifications: productSpecifications,
      salesChannel: salesChannel || 'both',
      supplier: supplier?.trim() || null,
      variants: variants.map(v => ({
        ...v,
        status: v.quantity > 0 ? 'in_stock' : 'out_of_stock'
      })),
      createdBy: req.user?._id,
      updatedBy: req.user?._id
    });

    if (status) product.status = status;
    else product.updateOverallStatus();

    await product.save();
    
    // Populate for response
    if (populateResponse) {
      await product.populate('brand', 'name');
      await product.populate('category', 'name');
    }

    return res.status(201).json({
      message: "HVAC product created successfully",
      product
    });
  } catch (err) {
    if (uploadedImage) {
      await deleteProductImage(uploadedImage.imagePublicId, uploadedImage.imageUrl).catch(() => {});
    }
    console.error("createHVACProduct 500:", err);
    return sendInventoryError(res, err);
  }
}

router.post("/hvac", productImageUpload, (req, res) => createHVACProduct(req, res));

/**
 * PATCH /api/admin/hvac/:id
 * Update an HVAC product
 */
router.patch("/hvac/:id", productImageUpload, async (req, res, next) => {
  let uploadedImage = null;
  let previousImagePublicId = null;
  let previousImageUrl = null;
  try {
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }

    const product = await HVACProduct.findById(id);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    if (product.active === false || product.archivedAt) {
      return res.status(409).json({ error: "Restore this product before editing it.", code: "HVAC_PRODUCT_ARCHIVED" });
    }

    let {
      modelLine,
      brand,
      category,
      type,
      inverter,
      status,
      warranty,
      description,
      imageUrl,
      specifications,
      salesChannel,
      supplier,
      variants
    } = req.body;

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

    previousImagePublicId = product.imagePublicId;
    previousImageUrl = product.imageUrl;
    if (req.file) {
      uploadedImage = await uploadProductImage(req.file);
      imageUrl = uploadedImage.imageUrl;
    }

    // Update fields
    if (modelLine) product.modelLine = modelLine.trim();
    if (brand) product.brand = brand;
    if (category) product.category = category;
    if (type !== undefined) product.type = type;
    if (inverter !== undefined) product.inverter = inverter;
    if (description !== undefined) product.description = description?.trim() || null;
    if (imageUrl !== undefined) {
      const normalizedImageUrl = imageUrl?.trim() || "/images/products/default.png";
      const imageChanged = normalizedImageUrl !== product.imageUrl;
      product.imageUrl = normalizedImageUrl;
      if (uploadedImage) product.imagePublicId = uploadedImage.imagePublicId;
      else if (imageChanged) product.imagePublicId = null;
    }
    if (specifications !== undefined) product.specifications = specifications || {};
    if (warranty !== undefined) {
      if (!product.specifications) product.specifications = {};
      product.specifications.warranty = String(warranty).trim() || "1 Year Compressor, 1 Year Parts";
    }
    if (salesChannel !== undefined) product.salesChannel = salesChannel;
    if (supplier !== undefined) product.supplier = supplier?.trim() || null;
    if (variants && variants.length > 0) {
      const variantsWithExistingSerials = variants.map((variantData) => {
        const existingVariant = variantData && variantData._id
          ? product.variants.id(variantData._id)
          : null;
        const existingData = existingVariant
          ? existingVariant.toObject({ depopulate: true })
          : {};
        return {
          ...existingData,
          ...variantData,
          serialNumbers: variantData.serialNumbers === undefined && existingVariant
            ? existingVariant.serialNumbers
            : variantData.serialNumbers,
        };
      });
      const normalizedVariants = normalizeProductVariantSerialNumbers(variantsWithExistingSerials.map(normalizeHvacPrices));
      await assertSerialNumbersAvailable(normalizedVariants, product._id);
      product.variants = normalizedVariants.map(v => ({
        ...v,
        status: v.quantity > 0 ? 'in_stock' : 'out_of_stock'
      }));
    }

    if (status !== undefined) product.status = status;
    else if (variants && variants.length > 0) product.updateOverallStatus();

    product.updatedBy = req.user?._id;
    await product.save();
    if (product.imageUrl !== previousImageUrl && previousImageUrl !== "/images/products/default.png") {
      await deleteProductImage(previousImagePublicId, previousImageUrl).catch(() => {});
    }

    // Populate for response
    await product.populate('brand', 'name');
    await product.populate('category', 'name');

    return res.json({
      message: "HVAC product updated successfully",
      product
    });
  } catch (err) {
    if (uploadedImage) {
      await deleteProductImage(uploadedImage.imagePublicId, uploadedImage.imageUrl).catch(() => {});
    }
    console.error("updateHVACProduct 500:", err);
    return sendInventoryError(res, err);
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
    if (product.active === false || product.archivedAt) {
      return res.status(409).json({ error: "Restore this product before adding variants.", code: "HVAC_PRODUCT_ARCHIVED" });
    }

    const variantData = normalizeHvacPrices(req.body.variant || {});
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

    const newVariant = normalizeVariantSerialNumbers({
      _id: new mongoose.Types.ObjectId(),
      capacity: String(capacity),
      btu: parseFloat(btu) || 0,
      sellingPrice: parseFloat(sellingPrice) || 0,
      costPrice: parseFloat(costPrice) || 0,
      quantity: qty,
      minStockLevel: msl,
      status: qty > 0 ? (qty <= msl ? 'low_stock' : 'in_stock') : 'out_of_stock',
      active: true,
      serialNumbers: variantData.serialNumbers,
    });

    const candidateVariants = [
      ...product.variants.map((variant) => variant.toObject()),
      newVariant,
    ];
    normalizeProductVariantSerialNumbers(candidateVariants);
    await assertSerialNumbersAvailable([newVariant], product._id);

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
    return sendInventoryError(res, err);
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
    if (product.active === false || product.archivedAt) {
      return res.status(409).json({ error: "Restore this product before editing variants.", code: "HVAC_PRODUCT_ARCHIVED" });
    }

    const variant = product.variants.id(variantId);
    if (!variant) {
      return res.status(404).json({ error: "Variant not found" });
    }

    const variantData = normalizeHvacPrices(req.body.variant || {});
    const { capacity, btu, sellingPrice, costPrice, quantity, minStockLevel } = variantData;

    if (capacity !== undefined) variant.capacity = String(capacity);
    if (btu !== undefined) variant.btu = parseFloat(btu) || 0;
    if (sellingPrice !== undefined) variant.sellingPrice = parseFloat(sellingPrice) || 0;
    if (costPrice !== undefined) variant.costPrice = parseFloat(costPrice) || 0;
    if (quantity !== undefined) variant.quantity = parseFloat(quantity) || 0;
    if (minStockLevel !== undefined) variant.minStockLevel = parseFloat(minStockLevel) || 3;
    const normalizedVariant = normalizeVariantSerialNumbers({
      ...variant.toObject(),
      serialNumbers: variantData.serialNumbers !== undefined
        ? variantData.serialNumbers
        : variant.serialNumbers,
    });
    const candidateVariants = product.variants.map((candidate) =>
      String(candidate._id) === String(variant._id)
        ? normalizedVariant
        : candidate.toObject(),
    );
    normalizeProductVariantSerialNumbers(candidateVariants);
    await assertSerialNumbersAvailable([normalizedVariant], product._id);
    variant.serialNumbers = normalizedVariant.serialNumbers;

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
    return sendInventoryError(res, err);
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

    const reason = normalizeLifecycleReason(req.body?.reason, "Archive", {
      fallback: "Archived from the aircon catalogue by an administrator",
    });
    archiveRecord(product, req.user._id, reason);
    product.updatedBy = req.user?._id;
    await product.save();
    await audit.logEvent({ actor: req.user._id, target: product._id, action: "hvac.archive", module: "inventory", req, details: { reason } });

    return res.json({ 
      message: "HVAC product archived successfully",
      product 
    });
  } catch (err) {
    console.error("archiveHVACProduct 500:", err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.post("/hvac/:id/restore", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid product id" });
    const product = await HVACProduct.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    const reason = normalizeLifecycleReason(req.body?.reason, "Restore", {
      fallback: "Restored to the aircon catalogue by an administrator",
    });
    restoreRecord(product, req.user._id, reason);
    product.updatedBy = req.user._id;
    await product.save();
    await audit.logEvent({ actor: req.user._id, target: product._id, action: "hvac.restore", module: "inventory", req, details: { reason } });
    return res.json({ message: "HVAC product restored successfully", product });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
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
