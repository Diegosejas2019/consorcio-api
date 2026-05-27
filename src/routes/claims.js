const router        = require('express').Router();
const ctrl          = require('../controllers/claimController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../middleware/features');
const { requirePermissionForAdmin, requirePermission } = require('../middleware/permissions');
const { uploadClaim } = require('../config/cloudinary');

router.use(protect, requireOrg, requireFeature('claims'));

router.get('/',    requirePermissionForAdmin('claims.read'), ctrl.getClaims);
router.post('/',   restrictTo('owner'), uploadClaim.array('attachments', 3), ctrl.createClaim);
router.get('/:id/attachment/:index', ctrl.getAttachment);
router.patch('/:id/status', restrictTo('admin'), requirePermission('claims.respond'), ctrl.updateStatus);
router.delete('/:id', requirePermissionForAdmin('claims.delete'), ctrl.deleteClaim);

module.exports = router;
