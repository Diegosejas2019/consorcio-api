const express = require('express');
const router  = express.Router();
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');
const {
  getUnits,
  createUnit,
  bulkCreateUnits,
  updateUnit,
  deleteUnit,
  assignOwner,
  releaseOwner,
} = require('../controllers/unitController');

router.use(protect, requireOrg);

router.get('/',     requirePermissionForAdmin('units.read'), getUnits);
router.post('/',    restrictTo('admin', 'superadmin'), requirePermission('units.create'), createUnit);
router.post('/bulk', restrictTo('admin', 'superadmin'), requirePermission('units.create'), bulkCreateUnits);
router.patch('/:id/assign-owner',  restrictTo('admin', 'superadmin'), requirePermission('units.update'), assignOwner);
router.patch('/:id/release-owner', restrictTo('admin', 'superadmin'), requirePermission('units.update'), releaseOwner);
router.patch('/:id', restrictTo('admin', 'superadmin'), requirePermission('units.update'), updateUnit);
router.delete('/:id', restrictTo('admin', 'superadmin'), requirePermission('units.delete'), deleteUnit);

module.exports = router;
