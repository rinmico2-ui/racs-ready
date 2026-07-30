const express = require("express");
const router = express.Router();
const AirconCart = require("../models/AirconCart");
const Inventory = require("../models/Inventory");
const auth = require("../middleware/authenticate");

// ── Auth Guard ─────────────────────────────────────────────────────────────
router.use(auth.authenticate);
router.use(auth.requireRole("customer"));

/**
 * GET /api/aircon-cart
 * Fetch the current user's aircon cart.
 */
router.get("/", async (req, res) => {
  try {
    let cart = await AirconCart.findOne({ userId: req.user._id }).lean();

    if (!cart) {
      cart = { userId: req.user._id, items: [] };
    } else {
      const HVACProduct = require("../models/HVACProduct");
      const Brand = require("../models/Brand");

      for (let i = cart.items.length - 1; i >= 0; i--) {
        const item = cart.items[i];
        const id = item.inventoryId;
        
        let inv = await Inventory.findById(id).lean();
        if (inv) {
          if (inv.brand) inv.brand = await Brand.findById(inv.brand).select("name").lean();
          item.inventoryId = inv;
        } else {
          const hvacDoc = await HVACProduct.findOne({ "variants._id": id }).populate("brand", "name").lean();
          if (hvacDoc) {
            const variant = hvacDoc.variants.find(v => v._id.toString() === id.toString());
            item.inventoryId = {
              _id: variant._id,
              modelLine: hvacDoc.modelLine,
              brand: hvacDoc.brand,
              capacity: variant.capacity,
              capacityUnit: variant.capacityUnit,
              sellingPrice: variant.sellingPrice,
              imageUrl: hvacDoc.imageUrl,
              inverter: hvacDoc.inverter
            };
          } else {
            cart.items.splice(i, 1);
          }
        }
      }
    }

    // Compute totalAmount from items
    let totalAmount = 0;
    for (const item of cart.items) {
      const price = (item.inventoryId && typeof item.inventoryId === 'object')
        ? (item.inventoryId.sellingPrice || 0)
        : 0;
      totalAmount += price * (item.quantity || 1);
    }
    cart.totalAmount = totalAmount;

    res.json({ cart });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/aircon-cart/add
 * Add or update an item in the cart.
 * Body: { inventoryId, quantity }
 */
router.post("/add", async (req, res) => {
  try {
    const { inventoryId, quantity = 1 } = req.body;
    if (!inventoryId) return res.status(400).json({ error: "inventoryId is required" });

    // Validate inventory exists
    const HVACProduct = require("../models/HVACProduct");
    let item = await Inventory.findById(inventoryId);
    if (!item) {
      const hvacDoc = await HVACProduct.findOne({ "variants._id": inventoryId }).lean();
      if (hvacDoc) {
        item = hvacDoc.variants.find(v => v._id.toString() === inventoryId.toString());
      }
    }
    if (!item) return res.status(404).json({ error: "Product not found" });

    let cart = await AirconCart.findOne({ userId: req.user._id });

    if (!cart) {
      cart = new AirconCart({ userId: req.user._id, items: [] });
    }

    const existingItemIdx = cart.items.findIndex(
      (it) => it.inventoryId.toString() === inventoryId
    );

    if (existingItemIdx > -1) {
      cart.items[existingItemIdx].quantity += quantity;
    } else {
      cart.items.push({ inventoryId, quantity });
    }

    await cart.save();
    res.json({ message: "Item added to cart", cart });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/aircon-cart/:itemId
 * Remove specific item from cart.
 */
router.delete("/:itemId", async (req, res) => {
  try {
    const cart = await AirconCart.findOne({ userId: req.user._id });
    if (!cart) return res.status(404).json({ error: "Cart not found" });

    cart.items = cart.items.filter((it) => it._id.toString() !== req.params.itemId);
    await cart.save();

    res.json({ message: "Item removed from cart", cart });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/aircon-cart/clear
 * Clear the current user's cart.
 */
router.post("/clear", async (req, res) => {
  try {
    await AirconCart.findOneAndUpdate(
      { userId: req.user._id },
      { $set: { items: [] } }
    );
    res.json({ message: "Cart cleared" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/aircon-cart/buy-now
 * Clear cart and add a single item (Buy Now flow).
 * Body: { inventoryId, quantity }
 */
router.post("/buy-now", async (req, res) => {
  try {
    const { inventoryId, quantity = 1 } = req.body;
    if (!inventoryId) return res.status(400).json({ error: "inventoryId is required" });

    // Validate inventory exists
    const HVACProduct = require("../models/HVACProduct");
    let item = await Inventory.findById(inventoryId);
    if (!item) {
      const hvacDoc = await HVACProduct.findOne({ "variants._id": inventoryId }).lean();
      if (hvacDoc) {
        item = hvacDoc.variants.find(v => v._id.toString() === inventoryId.toString());
      }
    }
    if (!item) return res.status(404).json({ error: "Product not found" });

    let cart = await AirconCart.findOne({ userId: req.user._id });
    if (!cart) {
      cart = new AirconCart({ userId: req.user._id, items: [] });
    }

    // Clear existing items and add only the selected one
    cart.items = [{ inventoryId, quantity }];
    await cart.save();

    res.json({ message: "Order ready for checkout", redirect: "/aircon-cart?checkout=now" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
