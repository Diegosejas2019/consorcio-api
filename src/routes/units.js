const express = require('express');
const router  = express.Router();
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
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

router.get('/',     getUnits);
router.post('/',    restrictTo('admin', 'superadmin'), createUnit);
router.post('/bulk', restrictTo('admin', 'superadmin'), bulkCreateUnits);
router.patch('/:id/assign-owner',  restrictTo('admin', 'superadmin'), assignOwner);
router.patch('/:id/release-owner', restrictTo('admin', 'superadmin'), releaseOwner);
router.patch('/:id', restrictTo('admin', 'superadmin'), updateUnit);
router.delete('/:id', restrictTo('admin', 'superadmin'), deleteUnit);

module.exports = router;
