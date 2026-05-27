const router = require('express').Router();
const ctrl   = require('../controllers/spaceController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../middleware/features');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');

router.use(protect, requireOrg, requireFeature('reservations'));

router.get('/',     requirePermissionForAdmin('spaces.read'), ctrl.getSpaces);
router.post('/',    restrictTo('admin'), requirePermission('spaces.create'), ctrl.createSpace);
router.patch('/:id', restrictTo('admin'), requirePermission('spaces.update'), ctrl.updateSpace);
router.delete('/:id', restrictTo('admin'), requirePermission('spaces.delete'), ctrl.deleteSpace);

module.exports = router;
