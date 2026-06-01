const router = require('express').Router();
const ctrl = require('../controllers/superAdminController');
const { protect, restrictTo } = require('../middleware/auth');
const { blockOnImpersonation } = require('../middleware/impersonation');

router.use(protect, restrictTo('super_admin'));

router.get('/analytics/overview', ctrl.getAnalyticsOverview);
router.get('/analytics/daily-activity', ctrl.getDailyActivity);
router.get('/analytics/organizations', ctrl.getOrganizationAnalytics);
router.get('/analytics/modules', ctrl.getModuleAnalytics);
router.patch('/users/password', blockOnImpersonation, ctrl.updateUserPasswordByEmail);
router.patch('/organizations/:id/status', blockOnImpersonation, ctrl.updateOrganizationStatus);

module.exports = router;
