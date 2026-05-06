const router = require('express').Router();
const ctrl   = require('../controllers/expenseController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { upload } = require('../config/cloudinary');

// Accesible a todos los usuarios autenticados con organización
router.get('/summary', protect, requireOrg, ctrl.getExpensesSummary);

// El resto solo para admin
router.use(protect, restrictTo('admin'));

router.get('/categories',                ctrl.getExpenseCategories);
router.post('/categories',               ctrl.createExpenseCategory);
router.get('/',                          ctrl.getExpenses);
router.post('/',                         upload.array('attachments', 5), ctrl.createExpense);
router.patch('/:id',                     upload.array('attachments', 5), ctrl.updateExpense);
router.get('/:id/attachment/:index',     ctrl.getAttachment);
router.delete('/:id/attachment/:index',  ctrl.deleteAttachment);
router.patch('/:id/paid',                ctrl.markAsPaid);
router.delete('/:id',                    ctrl.deleteExpense);

module.exports = router;
