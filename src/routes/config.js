const router = require('express').Router();
const ctrl   = require('../controllers/configController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermissionForAdmin, requirePermission } = require('../middleware/permissions');

router.get('/',    protect, requirePermissionForAdmin('settings.read'), ctrl.getConfig);
router.patch('/',  protect, restrictTo('admin'), requirePermission('settings.update'), ctrl.updateConfig);

module.exports = router;
