/**
 * authMiddleware.js
 * - session-based route protection (express-session)
 * - provide requireLogin and requireRole helpers
 *
 * Usage:
 * app.use('/dashboard', requireLogin, dashboardRouter);
 */
const User = require('../models/User');

module.exports = {
  requireLogin: async function (req, res, next) {
    try {
      if (!req.session || !req.session.userId) {
        return res.redirect('/login');
      }
      const user = await User.findById(req.session.userId).select('-passwordHash');
      if (!user) {
        req.session.destroy(() => {});
        return res.redirect('/login');
      }

      // Optional: check for session revocation stored on user.currentSessionId or DB
      if (user.lastPasswordChange && req.session.createdAt && (req.session.createdAt < user.lastPasswordChange)) {
        req.session.destroy(() => {});
        return res.redirect('/login');
      }

      req.user = user;
      res.locals.user = user;
      next();
    } catch (err) {
      next(err);
    }
  },

  requireRole: function (roles) {
    return function (req, res, next) {
      if (!req.user) return res.redirect('/login');
      const allowed = Array.isArray(roles) ? roles : [roles];
      if (!allowed.includes(req.user.role)) return res.redirect('/access-denied');
      next();
    };
  }
};
