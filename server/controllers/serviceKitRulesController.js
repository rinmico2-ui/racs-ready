'use strict';
const service = require('../utils/serviceKitRules').createService();

function createController(rules = service) {
  return {
    async list(req, res, next) {
      try { res.set('Cache-Control', 'private, no-store'); return res.json({ success: true, ...await rules.list() }); } catch (error) { next(error); }
    },
    async save(req, res, next) {
      try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Only admin can change service kit rules.' });
        const rule = await rules.save({ ...req.params, payload: req.body, userId: req.user._id });
        return res.json({ success: true, rule });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    },
  };
}
module.exports = { ...createController(), createController };
