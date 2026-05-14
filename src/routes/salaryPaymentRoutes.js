const router = require('express').Router();
const ctrl = require('../controllers/salaryPaymentController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(protect, requireOrg, restrictTo('admin'));

router.get('/', requirePermission('salaries.read'), ctrl.getSalaryPayments);
router.post('/', requirePermission('salaries.update'), ctrl.createSalaryPayment);
router.delete('/:id', requirePermission('salaries.update'), ctrl.deleteSalaryPayment);

module.exports = router;
