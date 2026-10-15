const express = require("express");
const router = express.Router();
const AirconCart = require("../models/AirconCart");
const Inventory = require("../models/Inventory");
const auth = require("../middleware/authenticate");
const mongoose = require('mongoose');
const { availability } = require('../public/js/product-availability');

async function findPurchasableProduct(inventoryId) {
  if (typeof inventoryId !== 'string' || !mongoose.isObjectIdOrHexString(inventoryId)) {
    throw Object.assign(new Error('Select a valid HP configuration and try again.'), { status: 400, code: 'INVALID_PRODUCT' });
  }
  const identifier = inventoryId.toLowerCase();
  let item = await Inventory.findById(identifier);
  let parent;
  if (!item) {
    parent = await require('../models/HVACProduct').findOne({ 'variants._id': identifier }).lean();
    item = parent && parent.variants.find(v => String(v._id) === identifier);
  }
  if (!item) throw Object.assign(new Error('This HP configuration no longer exists. Refresh the product page.'), { status: 404, code: 'PRODUCT_NOT_FOUND' });
  return { item, availability: availability(item, parent) };
}

function cartError(res, error, fallback) {
  if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error.code === 11000 || error.name === 'VersionError') return res.status(409).json({ error: 'Your cart changed in another request. Refresh your cart before trying again.', code: 'CART_CHANGED' });
  console.error('[aircon-cart]', error.name, error.code || '');
  return res.status(503).json({ error: fallback, code: 'CART_UNAVAILABLE' });
}

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
          inv.status = availability(inv).status;
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
              status: availability(variant, hvacDoc).status,
              active: availability(variant, hvacDoc).available,
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
    if (!['number', 'string'].includes(typeof quantity) || !Number.isSafeInteger(quantityChange) || quantityChange === 0) {
      return res.status(400).json({ error: "Quantity change must be a non-zero whole number" });
    }

    const product = await findPurchasableProduct(inventoryId);
    const availableStock = product.availability.stock;

    let cart = await AirconCart.findOne({ userId: req.user._id });

    if (!cart) {
      cart = new AirconCart({ userId: req.user._id, items: [] });
    }

    const existingItemIdx = cart.items.findIndex(
      (it) => it.inventoryId.toString() === inventoryId.toLowerCase()
    );
    const currentQuantity = existingItemIdx > -1 ? Number(cart.items[existingItemIdx].quantity) || 0 : 0;
    const nextQuantity = currentQuantity + quantityChange;
    if (nextQuantity < 1) {
      return res.status(400).json({ error: "Quantity cannot be less than one. Remove the item instead." });
    }
    if (quantityChange > 0 && !product.availability.available) {
      return res.status(409).json({ error: product.availability.message, code: 'PRODUCT_UNAVAILABLE' });
    }
    if (quantityChange > 0 && nextQuantity > availableStock) {
      return res.status(409).json({ error: `Only ${availableStock} unit${availableStock === 1 ? ' is' : 's are'} available. You already have ${currentQuantity} in your cart; you can add ${Math.max(0, availableStock - currentQuantity)} more.`, code: 'STOCK_LIMIT', availableStock, currentQuantity });
    }

    if (existingItemIdx > -1) {
      cart.items[existingItemIdx].quantity = nextQuantity;
    } else {
      cart.items.push({ inventoryId, quantity: quantityChange });
    }

    await cart.save();
    res.json({ message: "Item added to cart", cart });
  } catch (err) {
    cartError(res, err, 'The cart service is temporarily unavailable. Please try again shortly.');
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
    cartError(res, err, 'The item could not be removed. Refresh your cart and try again.');
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
      { $set: { items: [] }, $inc: { __v: 1 } }
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
    if (!['number', 'string'].includes(typeof quantity) || !Number.isSafeInteger(requestedQuantity) || requestedQuantity < 1) {
      return res.status(400).json({ error: "Quantity must be a positive whole number" });
    }

    const product = await findPurchasableProduct(inventoryId);
    const availableStock = product.availability.stock;
    if (!product.availability.available) return res.status(409).json({ error: product.availability.message, code: 'PRODUCT_UNAVAILABLE' });
    if (requestedQuantity > availableStock) return res.status(409).json({ error: `Only ${availableStock} units are available. Reduce the quantity or select another HP option.`, code: 'STOCK_LIMIT', availableStock });

    let cart = await AirconCart.findOne({ userId: req.user._id });
    if (!cart) {
      cart = new AirconCart({ userId: req.user._id, items: [] });
    }

    // Clear existing items and add only the selected one
    cart.items = [{ inventoryId, quantity: requestedQuantity }];
    await cart.save();

    res.json({ message: "Order ready for checkout", redirect: "/aircon-cart?checkout=now" });
  } catch (err) {
    cartError(res, err, 'Checkout is temporarily unavailable. Please try again shortly.');
  }
});

module.exports = router;
