const express = require('express');
const router  = express.Router();
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const {
  getUnits,
  createUnit,
  updateUnit,
  deleteUnit,
} = require('../controllers/unitController');

router.use(protect, requireOrg);

router.get('/',     getUnits);
router.post('/',    restrictTo('admin', 'superadmin'), createUnit);
router.patch('/:id', restrictTo('admin', 'superadmin'), updateUnit);
router.delete('/:id', restrictTo('admin', 'superadmin'), deleteUnit);

module.exports = router;
