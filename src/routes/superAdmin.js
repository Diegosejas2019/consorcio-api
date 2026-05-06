const router = require('express').Router();
const ctrl = require('../controllers/superAdminController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect, restrictTo('super_admin'));

router.patch('/users/password', ctrl.updateUserPasswordByEmail);
router.patch('/organizations/:id/status', ctrl.updateOrganizationStatus);

module.exports = router;
