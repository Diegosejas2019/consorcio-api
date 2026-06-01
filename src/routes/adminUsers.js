const router = require('express').Router();
const ctrl = require('../controllers/adminUserController');
const multiOrgCtrl = require('../controllers/adminMultiOrgController');
const { protect, requireOrg, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { blockOnImpersonation } = require('../middleware/impersonation');

router.use(protect, requireOrg, restrictTo('admin'));

router.get('/permissions/me', ctrl.getMyPermissions);
router.get('/owners/search', requirePermission('admins.create'), ctrl.searchOwnersForAdminInvite);
router.get('/users', requirePermission('admins.read'), ctrl.listAdmins);
router.post('/users/invite', blockOnImpersonation, requirePermission('admins.create'), ctrl.inviteAdmin);
router.patch('/users/:userId/role', blockOnImpersonation, requirePermission('admins.update'), ctrl.updateAdminRole);
router.patch('/users/:userId/disable', blockOnImpersonation, requirePermission('admins.disable'), ctrl.disableAdmin);

router.get('/multi-organization-summary', multiOrgCtrl.getMultiOrgSummary);

module.exports = router;
