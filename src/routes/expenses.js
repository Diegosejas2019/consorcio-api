const router    = require('express').Router();
const multer    = require('multer');
const ctrl      = require('../controllers/expenseController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../middleware/features');
const { requirePermission } = require('../middleware/permissions');
const { blockOnImpersonation } = require('../middleware/impersonation');
const { upload } = require('../config/cloudinary');

// Multer en memoria solo para preview (no sube a Cloudinary)
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Accesible a todos los usuarios autenticados con organización
router.get('/summary', protect, requireOrg, requireFeature('expenses'), ctrl.getExpensesSummary);

// El resto solo para admin
router.use(protect, requireOrg, requireFeature('expenses'), restrictTo('admin'));

router.get('/categories',                requirePermission('expenses.read'), ctrl.getExpenseCategories);
router.post('/categories',               requirePermission('expenses.create'), ctrl.createExpenseCategory);
router.get('/check-duplicate',           requirePermission('expenses.read'), ctrl.checkDuplicate);
router.post('/preview-invoice',          requirePermission('expenses.read'), memUpload.single('file'), ctrl.previewInvoice);
router.get('/',                          requirePermission('expenses.read'), ctrl.getExpenses);
router.post('/',                         blockOnImpersonation, requirePermission('expenses.create'), upload.array('attachments', 5), ctrl.createExpense);
router.patch('/:id',                     blockOnImpersonation, requirePermission('expenses.update'), upload.array('attachments', 5), ctrl.updateExpense);
router.get('/:id/attachment/:index',     requirePermission('expenses.read'), ctrl.getAttachment);
router.delete('/:id/attachment/:index',  blockOnImpersonation, requirePermission('expenses.update'), ctrl.deleteAttachment);
router.patch('/:id/paid',                blockOnImpersonation, requirePermission('expenses.update'), ctrl.markAsPaid);
router.delete('/:id',                    blockOnImpersonation, requirePermission('expenses.delete'), ctrl.deleteExpense);

module.exports = router;
