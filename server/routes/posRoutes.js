const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Tool = require("../models/Tool");
const HVACProduct = require("../models/HVACProduct");
const Inventory = require("../models/Inventory");
const WalkInSale = require("../models/WalkInSale");

// ─── Auth middleware (admin only) ─────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/tools/generate-barcodes — Generate barcodes for all tools missing them
// ─────────────────────────────────────────────────────────────────────────────
router.post("/tools/generate-barcodes", requireAdmin, async (req, res) => {
  try {
    const tools = await Tool.find({
      $and: [Tool.merchandiseFilter(), { $or: [{ barcode: { $exists: false } }, { barcode: "" }, { barcode: null }] }],
    }).lean();
    let updated = 0;
    for (const t of tools) {
      const base = `TOOL${t._id.toString().slice(-8).toUpperCase()}`;
      let candidate = base;
      let suffix = 0;
      while (await Tool.findOne({ barcode: candidate })) {
        suffix += 1;
        candidate = `${base}-${suffix}`;
      }
      await Tool.updateOne({ _id: t._id }, { $set: { barcode: candidate } });
      updated++;
    }
    res.json({ message: `Generated ${updated} barcodes`, updated });
  } catch (err) {
    console.error("Generate barcodes error:", err);
    res.status(500).json({ error: "Failed to generate barcodes" });
  }
});

router.use(requireAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/tools — Search available parts/tools for POS
// ─────────────────────────────────────────────────────────────────────────────
router.get("/tools", async (req, res) => {
  try {
    const { q, category, page = 1, limit = 50 } = req.query;
    const filter = { active: true, isStockItem: true, status: { $ne: "discontinued" }, $and: [Tool.merchandiseFilter()] };

    if (q && q.trim()) {
      const regex = new RegExp(q.trim(), "i");
      filter.$or = [
        { itemName: regex },
        { barcode: regex },
        { category: regex },
        { specification: regex },
      ];
    }
    if (category && category.trim()) {
      filter.category = category.trim();
    }

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [tools, total] = await Promise.all([
      Tool.find(filter)
        .sort({ itemName: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Tool.countDocuments(filter),
    ]);

    // Return only available stock (quantity - reserved)
    const availableTools = tools.map((t) => ({
      _id: t._id,
      itemName: t.itemName,
      category: t.category,
      unit: t.unit,
      barcode: t.barcode,
      serialNumber: t.serialNumber,
      sellingPrice: t.sellingPrice,
      costPrice: t.costPrice,
      available: Math.max(0, (t.quantity || 0) - (t.reservedQuantity || 0)),
      quantity: t.quantity,
      specification: t.specification,
    }));

    res.json({ tools: availableTools, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error("POS tools search error:", err);
    res.status(500).json({ error: "Failed to load parts" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/tools/barcode/:barcode — Lookup by barcode (searches Tools + Aircons + Inventory)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/tools/barcode/:barcode", async (req, res) => {
  try {
    const barcode = req.params.barcode;

    // 1. Try Tool collection first
    const tool = await Tool.findOne({ barcode, active: true, isStockItem: true, $and: [Tool.merchandiseFilter()] }).lean();
    if (tool) {
      const available = Math.max(0, (tool.quantity || 0) - (tool.reservedQuantity || 0));
      if (available <= 0) return res.status(400).json({ error: "Item is out of stock" });
      return res.json({
        _id: tool._id, itemName: tool.itemName, category: tool.category, unit: tool.unit,
        barcode: tool.barcode, serialNumber: tool.serialNumber,
        sellingPrice: tool.sellingPrice, costPrice: tool.costPrice,
        available, source: "tool",
      });
    }

    // 2. Try HVACProduct variants
    const hvac = await HVACProduct.findOne({ "variants.barcode": barcode, active: true }).lean();
    if (hvac) {
      const variant = hvac.variants.find(v => v.barcode === barcode && v.active !== false);
      if (variant) {
        const available = variant.quantity || 0;
        if (available <= 0) return res.status(400).json({ error: "Item is out of stock" });
        const brandDoc = hvac.brand && typeof hvac.brand === "object" ? hvac.brand : null;
        return res.json({
          _id: variant._id, parentHvacId: hvac._id,
          itemName: `${hvac.modelLine} ${variant.capacity}${variant.capacityUnit || "HP"}`,
          category: hvac.type || "Aircon", unit: "unit",
          barcode: variant.barcode, sellingPrice: variant.sellingPrice, costPrice: variant.costPrice,
          available, source: "aircon",
          brand: brandDoc ? brandDoc.name : "",
          modelLine: hvac.modelLine, capacity: variant.capacity, capacityUnit: variant.capacityUnit,
          inverter: hvac.inverter, imageUrl: hvac.imageUrl,
        });
      }
    }

    // 3. Try legacy Inventory collection
    const inv = await Inventory.findOne({ barcode, active: true }).lean();
    if (inv) {
      const available = inv.quantity || 0;
      if (available <= 0) return res.status(400).json({ error: "Item is out of stock" });
      return res.json({
        _id: inv._id, itemName: inv.modelLine + " " + inv.capacity + (inv.capacityUnit || "HP"),
        category: inv.type || "Aircon", unit: "unit",
        barcode: inv.barcode, sellingPrice: inv.sellingPrice, costPrice: inv.costPrice,
        available, source: "aircon_legacy",
        modelLine: inv.modelLine, capacity: inv.capacity, capacityUnit: inv.capacityUnit,
      });
    }

    return res.status(404).json({ error: "Item not found" });
  } catch (err) {
    console.error("POS barcode lookup error:", err);
    res.status(500).json({ error: "Failed to lookup barcode" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/aircons — List aircon units for POS (flattened from HVACProduct variants)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/aircons", async (req, res) => {
  try {
    const { q, brand, type } = req.query;
    const filter = { active: true };

    // Build variant-level match
    const variantMatch = {};
    if (q && q.trim()) {
      const regex = new RegExp(q.trim(), "i");
      variantMatch.$or = [
        { "variants.barcode": regex },
        { "variants.sku": regex },
      ];
      filter.$or = [
        { modelLine: regex },
        { description: regex },
        variantMatch,
      ];
    }

    // Fetch all active HVACProducts
    const products = await HVACProduct.find(filter)
      .populate("brand", "name")
      .populate("category", "name")
      .sort({ modelLine: 1 })
      .lean();

    // Flatten variants into individual sellable items
    const items = [];
    for (const p of products) {
      if (!p.variants || !p.variants.length) continue;
      for (const v of p.variants) {
        if (v.active === false) continue;
        const available = v.quantity || 0;
        if (available <= 0) continue; // Skip out-of-stock

        // Apply brand/type filter after population
        if (brand && p.brand && p.brand.name !== brand) continue;
        if (type && p.type !== type) continue;

        items.push({
          _id: v._id,
          parentHvacId: p._id,
          itemName: `${p.modelLine} ${v.capacity}${v.capacityUnit || "HP"}`,
          modelLine: p.modelLine,
          brand: p.brand ? p.brand.name : "",
          category: p.type || "Aircon",
          type: p.type,
          capacity: v.capacity,
          capacityUnit: v.capacityUnit || "HP",
          btu: v.btu || 0,
          inverter: p.inverter,
          barcode: v.barcode || "",
          sku: v.sku || "",
          sellingPrice: v.sellingPrice || 0,
          costPrice: v.costPrice || 0,
          available,
          unit: "unit",
          imageUrl: p.imageUrl || "",
          warranty: p.specifications?.warranty || "1 Year Compressor, 1 Year Parts",
        });
      }
    }

    res.json({ items, total: items.length });
  } catch (err) {
    console.error("POS aircons error:", err);
    res.status(500).json({ error: "Failed to load aircons" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/aircon-brands — Distinct brands from HVAC products
// ─────────────────────────────────────────────────────────────────────────────
router.get("/aircon-brands", async (req, res) => {
  try {
    const products = await HVACProduct.find({ active: true }).populate("brand", "name").lean();
    const brands = [...new Set(products.map(p => p.brand?.name).filter(Boolean))].sort();
    res.json({ brands });
  } catch (err) {
    res.status(500).json({ error: "Failed to load brands" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/aircon-generate-barcodes — Generate barcodes for aircon variants missing them
// ─────────────────────────────────────────────────────────────────────────────
router.post("/aircon-generate-barcodes", requireAdmin, async (req, res) => {
  try {
    let updated = 0;
    const products = await HVACProduct.find({ active: true });
    for (const p of products) {
      let changed = false;
      for (const v of p.variants) {
        if (!v.barcode) {
          const base = `AC${p._id.toString().slice(-6).toUpperCase()}${v.capacity.replace(".", "")}HP`;
          let candidate = base;
          let suffix = 0;
          while (await HVACProduct.findOne({ "variants.barcode": candidate })) {
            suffix += 1;
            candidate = `${base}-${suffix}`;
          }
          v.barcode = candidate;
          changed = true;
          updated++;
        }
      }
      if (changed) await p.save();
    }
    res.json({ message: `Generated ${updated} aircon barcodes`, updated });
  } catch (err) {
    console.error("Aircon barcode gen error:", err);
    res.status(500).json({ error: "Failed to generate barcodes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/categories — List distinct categories
// ─────────────────────────────────────────────────────────────────────────────
router.get("/categories", async (req, res) => {
  try {
    const categories = await Tool.distinct("category", {
      active: true,
      isStockItem: true,
      status: { $ne: "discontinued" },
      $and: [Tool.merchandiseFilter()],
    });
    res.json({ categories: categories.filter(Boolean).sort() });
  } catch (err) {
    res.status(500).json({ error: "Failed to load categories" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/checkout — Process a walk-in sale
// ─────────────────────────────────────────────────────────────────────────────
router.post("/checkout", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { customerName, customerPhone, customerTin, customerAddress, items, paymentMethod, amountPaid, discount, notes } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: "No items in cart" });
    }
    if (!paymentMethod) {
      return res.status(400).json({ error: "Payment method is required" });
    }
    if (amountPaid == null || Number(amountPaid) < 0) {
      return res.status(400).json({ error: "Invalid payment amount" });
    }

    // ── Validate & reserve stock ───────────────────────────────────────────
    const saleItems = [];
    let subtotal = 0;
    let totalCost = 0;

    for (const item of items) {
      if (!item.toolId || !item.quantity || item.quantity <= 0) {
        throw new Error(`Invalid item: ${JSON.stringify(item)}`);
      }

      let itemName, category, unit, unitPrice, costPrice, available, serialNumber;
      const source = item.source || "tool";

      if (source === "aircon" || source === "aircon_legacy") {
        // Look up in HVACProduct variants or legacy Inventory
        let found = false;
        const hvac = await HVACProduct.findOne({ "variants._id": item.toolId }).session(session);
        if (hvac) {
          const variant = hvac.variants.id(item.toolId);
          if (!variant) throw new Error(`Aircon variant not found: ${item.toolId}`);
          if ((variant.quantity || 0) < item.quantity) {
            throw new Error(`Insufficient stock for "${hvac.modelLine} ${variant.capacity}${variant.capacityUnit || "HP"}": ${variant.quantity} available, ${item.quantity} requested`);
          }
          variant.quantity -= item.quantity;
          await hvac.save({ session });
          itemName = `${hvac.modelLine} ${variant.capacity}${variant.capacityUnit || "HP"}`;
          category = hvac.type || "Aircon";
          unit = "unit";
          unitPrice = variant.sellingPrice || 0;
          costPrice = variant.costPrice || 0;
          available = variant.quantity;
          found = true;
        }
        if (!found) {
          // Try legacy Inventory
          const inv = await Inventory.findById(item.toolId).session(session);
          if (!inv) throw new Error(`Item not found: ${item.toolId}`);
          if ((inv.quantity || 0) < item.quantity) {
            throw new Error(`Insufficient stock for "${inv.modelLine}": ${inv.quantity} available, ${item.quantity} requested`);
          }
          inv.quantity -= item.quantity;
          await inv.save({ session });
          itemName = `${inv.modelLine} ${inv.capacity || ""}${inv.capacityUnit || "HP"}`;
          category = inv.type || "Aircon";
          unit = "unit";
          unitPrice = inv.sellingPrice || 0;
          costPrice = inv.costPrice || 0;
          available = inv.quantity;
        }
      } else {
        // Tool
        const tool = await Tool.findById(item.toolId).session(session);
        if (!tool) throw new Error(`Tool not found: ${item.toolId}`);
        if (Tool.effectiveInventoryClass(tool) !== 'merchandise') {
          throw new Error(`${tool.itemName} is an operational asset and cannot be sold`);
        }
        if (!tool.active) throw new Error(`${tool.itemName} is no longer available`);

        available = (tool.quantity || 0) - (tool.reservedQuantity || 0);
        if (available < item.quantity) {
          throw new Error(`Insufficient stock for "${tool.itemName}": ${available} available, ${item.quantity} requested`);
        }
        tool.quantity = (tool.quantity || 0) - item.quantity;
        await tool.save({ session });
        itemName = tool.itemName;
        category = tool.category;
        unit = tool.unit;
        unitPrice = tool.sellingPrice || 0;
        costPrice = tool.costPrice || 0;
        serialNumber = tool.serialNumber || null;
      }

      const totalPrice = unitPrice * item.quantity;

      saleItems.push({
        toolId: item.toolId,
        itemName,
        category,
        unit,
        quantity: item.quantity,
        unitPrice,
        costPrice,
        totalPrice,
        serialNumber,
      });

      subtotal += totalPrice;
      totalCost += costPrice * item.quantity;
    }

    const discountAmt = Math.max(0, Number(discount) || 0);
    const totalAmount = Math.max(0, subtotal - discountAmt);
    const totalProfit = totalAmount - totalCost;
    const change = Math.max(0, (Number(amountPaid) || 0) - totalAmount);

    // ── Generate invoice number (pre-save hook may not work inside sessions) ──
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const prefix = `WIS-${yy}${mm}${dd}`;
    const lastSale = await WalkInSale.findOne({ invoiceNumber: { $regex: `^${prefix}` } })
      .sort({ invoiceNumber: -1 }).lean();
    let seq = 1;
    if (lastSale && lastSale.invoiceNumber) {
      const lastSeq = parseInt(lastSale.invoiceNumber.split("-").pop(), 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    const invoiceNumber = `${prefix}-${String(seq).padStart(4, "0")}`;

    // ── Create sale record ─────────────────────────────────────────────────
    const sale = new WalkInSale({
      invoiceNumber,
      customerName: (customerName || "").trim() || "Walk-In Customer",
      customerPhone: (customerPhone || "").trim() || null,
      customerTin: (customerTin || "").trim() || null,
      customerAddress: (customerAddress || "").trim() || null,
      items: saleItems,
      subtotal,
      discount: discountAmt,
      tax: 0,
      totalAmount,
      totalCost,
      totalProfit,
      paymentMethod,
      amountPaid: Number(amountPaid) || 0,
      change,
      status: "completed",
      processedBy: req.user._id,
      processedByName: req.user.name || req.user.email || "Admin",
      notes: (notes || "").trim() || null,
      completedAt: new Date(),
    });

    await sale.save({ session });
    await session.commitTransaction();

    require("../utils/audit").logEvent({
      actor: req.user && req.user._id,
      action: "pos.sale.create",
      module: "WalkInSale",
      details: { invoiceNumber, customerName: sale.customerName, totalAmount, paymentMethod, itemCount: saleItems.length },
      entityId: sale._id,
      entityType: "WalkInSale",
      category: "order",
      actionType: "created",
      actorRole: req.user && req.user.role,
      actorName: (req.user && (req.user.name || req.user.email)) || "Admin",
      req,
    });

    // Return populated sale for receipt
    const receipt = await WalkInSale.findById(sale._id).lean();
    res.json({ success: true, sale: receipt });
  } catch (err) {
    await session.abortTransaction();
    console.error("POS checkout error:", err);
    res.status(400).json({ error: err.message || "Checkout failed" });
  } finally {
    session.endSession();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/sales — List walk-in sales (with filters)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sales", async (req, res) => {
  try {
    const { status, from, to, page = 1, limit = 20, q, category } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (q) {
      filter.$or = [
        { invoiceNumber: { $regex: q, $options: "i" } },
        { customerName: { $regex: q, $options: "i" } },
      ];
    }
    if (category) {
      filter.items = { $elemMatch: { category: { $regex: category, $options: "i" } } };
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to + "T23:59:59");
    }

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [sales, total] = await Promise.all([
      WalkInSale.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      WalkInSale.countDocuments(filter),
    ]);

    // Summary stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const todayStats = await WalkInSale.aggregate([
      { $match: { status: "completed", createdAt: { $gte: today, $lte: todayEnd } } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$totalAmount" }, profit: { $sum: "$totalProfit" } } },
    ]);

    res.json({
      sales,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      todayStats: todayStats[0] || { count: 0, revenue: 0, profit: 0 },
    });
  } catch (err) {
    console.error("POS sales list error:", err);
    res.status(500).json({ error: "Failed to load sales" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/sales/:id — Get single sale for receipt
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sales/:id", async (req, res) => {
  try {
    const sale = await WalkInSale.findById(req.params.id).lean();
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    res.json({ sale });
  } catch (err) {
    res.status(500).json({ error: "Failed to load sale" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/sales/:id/void — Void a completed sale
// ─────────────────────────────────────────────────────────────────────────────
router.post("/sales/:id/void", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const sale = await WalkInSale.findById(req.params.id).session(session);
    if (!sale) throw new Error("Sale not found");
    if (sale.status === "voided") throw new Error("Sale is already voided");

    // Restore stock
    for (const item of sale.items) {
      const tool = await Tool.findById(item.toolId).session(session);
      if (tool) {
        tool.quantity = (tool.quantity || 0) + item.quantity;
        await tool.save({ session });
      }
    }

    sale.status = "voided";
    sale.voidedAt = new Date();
    sale.voidReason = (req.body.reason || "").trim() || "Admin void";
    await sale.save({ session });

    await session.commitTransaction();

    require("../utils/audit").logEvent({
      actor: req.user && req.user._id,
      action: "pos.sale.void",
      module: "WalkInSale",
      details: { invoiceNumber: sale.invoiceNumber, reason: sale.voidReason, totalAmount: sale.totalAmount },
      entityId: sale._id,
      entityType: "WalkInSale",
      category: "order",
      actionType: "deleted",
      actorRole: req.user && req.user.role,
      actorName: (req.user && (req.user.name || req.user.email)) || "Admin",
      req,
    });

    res.json({ success: true, sale });
  } catch (err) {
    await session.abortTransaction();
    console.error("POS void error:", err);
    res.status(400).json({ error: err.message || "Void failed" });
  } finally {
    session.endSession();
  }
});

module.exports = router;
