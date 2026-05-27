const router = require('express').Router();
const ctrl   = require('../controllers/configController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermissionForAdmin, requirePermission } = require('../middleware/permissions');

router.get('/',    protect, requireOrg, requirePermissionForAdmin('settings.read'), ctrl.getConfig);
router.patch('/',  protect, requireOrg, restrictTo('admin'), requirePermission('settings.update'), ctrl.updateConfig);

module.exports = router;
