const router = require('express').Router();
const ctrl   = require('../controllers/ownerDebtItemController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.patch('/:id/cancel', protect, restrictTo('admin'), requirePermission('debt.cancel'), ctrl.cancelDebtItem);
router.get('/mine',         protect, restrictTo('owner'), requireOrg, ctrl.getMyDebtItems);

module.exports = router;
