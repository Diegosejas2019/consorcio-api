const router = require('express').Router();
const ctrl = require('../controllers/adminUserController');
const { protect, requireOrg, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(protect, requireOrg, restrictTo('admin'));

router.get('/permissions/me', ctrl.getMyPermissions);
router.get('/users', requirePermission('admins.read'), ctrl.listAdmins);
router.post('/users/invite', requirePermission('admins.create'), ctrl.inviteAdmin);
router.patch('/users/:userId/role', requirePermission('admins.update'), ctrl.updateAdminRole);
router.patch('/users/:userId/disable', requirePermission('admins.disable'), ctrl.disableAdmin);

module.exports = router;
