const router = require('express').Router();
const ctrl   = require('../controllers/ownerDebtItemController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');

router.patch('/:id/cancel', protect, restrictTo('admin'), ctrl.cancelDebtItem);
router.get('/mine',         protect, restrictTo('owner'), requireOrg, ctrl.getMyDebtItems);

module.exports = router;
