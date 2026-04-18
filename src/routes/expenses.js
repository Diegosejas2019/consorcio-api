const router = require('express').Router();
const ctrl   = require('../controllers/expenseController');
const { protect, restrictTo } = require('../middleware/auth');
const { upload } = require('../config/cloudinary');

router.use(protect, restrictTo('admin'));

router.get('/',              ctrl.getExpenses);
router.post('/',             upload.single('receipt'), ctrl.createExpense);
router.patch('/:id',         ctrl.updateExpense);
router.patch('/:id/paid',    ctrl.markAsPaid);
router.delete('/:id',        ctrl.deleteExpense);

module.exports = router;
