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
      .select('_id itemName unit quantity costPrice status reservedQuantity')
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

module.exports = router;
