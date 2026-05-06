const router = require('express').Router();
const ctrl = require('../controllers/salaryPaymentController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');

router.use(protect, requireOrg, restrictTo('admin'));

router.get('/', ctrl.getSalaryPayments);
router.post('/', ctrl.createSalaryPayment);
router.delete('/:id', ctrl.deleteSalaryPayment);

module.exports = router;
