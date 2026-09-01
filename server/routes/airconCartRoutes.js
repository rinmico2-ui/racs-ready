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
              quantity: variant.quantity,
              status: variant.status,
              imageUrl: hvacDoc.imageUrl,
              inverter: hvacDoc.inverter,
              productId: hvacDoc._id
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
    res.status(500).json({ error: "Failed to load cart" });
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
    const quantityChange = Number(quantity);
    if (!Number.isInteger(quantityChange) || quantityChange === 0) {
      return res.status(400).json({ error: "Quantity change must be a non-zero whole number" });
    }

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
    const availableStock = Number(item.quantity) || 0;

    let cart = await AirconCart.findOne({ userId: req.user._id });

    if (!cart) {
      cart = new AirconCart({ userId: req.user._id, items: [] });
    }

    const existingItemIdx = cart.items.findIndex(
      (it) => it.inventoryId.toString() === inventoryId
    );
    const currentQuantity = existingItemIdx > -1 ? Number(cart.items[existingItemIdx].quantity) || 0 : 0;
    const nextQuantity = currentQuantity + quantityChange;
    if (nextQuantity < 1) {
      return res.status(400).json({ error: "Quantity cannot be less than one. Remove the item instead." });
    }
    const unavailable = availableStock < 1 || item.active === false || ["out_of_stock", "discontinued", "coming_soon"].includes(item.status);
    if (quantityChange > 0 && unavailable) {
      return res.status(409).json({ error: "This product is not currently available" });
    }
    if (quantityChange > 0 && nextQuantity > availableStock) {
      return res.status(409).json({ error: `Only ${availableStock} unit${availableStock === 1 ? " is" : "s are"} currently available` });
    }

    if (existingItemIdx > -1) {
      cart.items[existingItemIdx].quantity = nextQuantity;
    } else {
      cart.items.push({ inventoryId, quantity: quantityChange });
    }

    await cart.save();
    res.json({ message: "Item added to cart", cart });
  } catch (err) {
    res.status(500).json({ error: "Failed to update cart" });
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
    res.status(500).json({ error: "Failed to remove cart item" });
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
    res.status(500).json({ error: "Failed to clear cart" });
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
    const requestedQuantity = Number(quantity);
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) {
      return res.status(400).json({ error: "Quantity must be a positive whole number" });
    }

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
    const availableStock = Number(item.quantity) || 0;
    if (availableStock < requestedQuantity || item.active === false || ["out_of_stock", "discontinued", "coming_soon"].includes(item.status)) {
      return res.status(409).json({ error: availableStock > 0 ? `Only ${availableStock} unit${availableStock === 1 ? " is" : "s are"} currently available` : "This product is not currently available" });
    }

    let cart = await AirconCart.findOne({ userId: req.user._id });
    if (!cart) {
      cart = new AirconCart({ userId: req.user._id, items: [] });
    }

    // Clear existing items and add only the selected one
    cart.items = [{ inventoryId, quantity: requestedQuantity }];
    await cart.save();

    res.json({ message: "Order ready for checkout", redirect: "/aircon-cart?checkout=now" });
  } catch (err) {
    res.status(500).json({ error: "Failed to prepare checkout" });
  }
});

module.exports = router;
