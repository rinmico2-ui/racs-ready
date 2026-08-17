const express = require('express');
const router = express.Router();
const auth = require('../middleware/authenticate');
const audit = require('../utils/audit');

// Update inventory item (placeholder)
router.post('/update', auth.authenticate, auth.requireRole('admin'), async (req, res) => {
  const { itemId, change, note } = req.body;
  try {
    // If an Inventory model exists, you can update it here. We'll log regardless.
    await audit.logEvent({ actor: req.user && req.user._id, target: itemId || null, action: 'inventory.update', module: 'inventory', req, details: { change, note } });
    return res.json({ message: 'Inventory update recorded' });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to record inventory update' });
  }
});

// Search the shared Tool catalog (used by project "Reserve Tools" picker)
router.get('/tools/search', auth.authenticate, auth.requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const Tool = require('../models/Tool');
    const q = (req.query.q || '').toString().trim();
    const filter = { active: { $ne: false } };
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.itemName = { $regex: safe, $options: 'i' };
    }
    const tools = await Tool.find(filter)
      .select('_id itemName unit quantity costPrice sellingPrice status reservedQuantity type itemType inventoryClass category')
      .sort({ itemName: 1 })
      .limit(30)
      .lean();
    // Expose available (unreserved) units so the admin can see what's free
    // for this project and avoid double-booking stock on other jobs.
    tools.forEach((t) => {
      t.reservedQuantity = t.reservedQuantity || 0;
      t.availableQuantity = Math.max(0, (t.quantity || 0) - t.reservedQuantity);
    });
    res.json({ tools });
  } catch (e) {
    console.error('Tool search error:', e.message);
    res.status(500).json({ error: 'Failed to search tools' });
  }
});

// Get estimated daily inventory snapshots for the last N days
// Uses current stock + completed walk-in sales to reverse-calculate previous levels
router.get('/snapshots', auth.authenticate, auth.requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const Tool = require('../models/Tool');
    const WalkInSale = require('../models/WalkInSale');
    const now = new Date();
    const startOfRange = new Date(now);
    startOfRange.setDate(startOfRange.getDate() - (days - 1));
    startOfRange.setHours(0, 0, 0, 0);

    const tools = await Tool.find({ active: { $ne: false } }).lean();
    const sales = await WalkInSale.find({ status: 'completed', createdAt: { $gte: startOfRange } }).lean();

    const snapshots = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);

      const soldByTool = {};
      sales.forEach((sale) => {
        if (sale.createdAt >= d) {
          (sale.items || []).forEach((item) => {
            const tid = item.toolId && item.toolId.toString();
            if (tid) soldByTool[tid] = (soldByTool[tid] || 0) + (item.quantity || 0);
          });
        }
      });

      let inStock = 0, lowStock = 0, outOfStock = 0;
      let totalValue = 0, totalProfit = 0;

      tools.forEach((t) => {
        const sold = soldByTool[t._id.toString()] || 0;
        const qty = (t.quantity || 0) + sold;
        const cost = (t.costPrice || 0) * qty;
        const value = (t.sellingPrice || 0) * qty;
        totalValue += value;
        totalProfit += (value - cost);
        if (qty === 0) outOfStock++;
        else if (qty < (t.minStockLevel || 1)) lowStock++;
        else inStock++;
      });

      snapshots.push({
        date: d,
        total: tools.length,
        inStock,
        lowStock,
        outOfStock,
        totalValue,
        totalProfit
      });
    }

    res.json({ snapshots });
  } catch (e) {
    console.error('Inventory snapshots error:', e);
    res.status(500).json({ error: 'Failed to load inventory snapshots' });
  }
});

module.exports = router;
