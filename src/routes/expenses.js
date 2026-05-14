const router = require('express').Router();
const ctrl   = require('../controllers/expenseController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { upload } = require('../config/cloudinary');

// Accesible a todos los usuarios autenticados con organización
router.get('/summary', protect, requireOrg, ctrl.getExpensesSummary);

// El resto solo para admin
router.use(protect, restrictTo('admin'));

router.get('/categories',                requirePermission('expenses.read'), ctrl.getExpenseCategories);
router.post('/categories',               requirePermission('expenses.create'), ctrl.createExpenseCategory);
router.get('/',                          requirePermission('expenses.read'), ctrl.getExpenses);
router.post('/',                         requirePermission('expenses.create'), upload.array('attachments', 5), ctrl.createExpense);
router.patch('/:id',                     requirePermission('expenses.update'), upload.array('attachments', 5), ctrl.updateExpense);
router.get('/:id/attachment/:index',     requirePermission('expenses.read'), ctrl.getAttachment);
router.delete('/:id/attachment/:index',  requirePermission('expenses.update'), ctrl.deleteAttachment);
router.patch('/:id/paid',                requirePermission('expenses.update'), ctrl.markAsPaid);
router.delete('/:id',                    requirePermission('expenses.delete'), ctrl.deleteExpense);

module.exports = router;
