const router = require('express').Router();
const mongoose = require('mongoose');
const multer = require('multer');
const ctrl = require('../controllers/unidentifiedPaymentController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');
const { upload } = require('../config/cloudinary');

const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const ok =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      name.endsWith('.csv') || name.endsWith('.xlsx');
    if (ok) cb(null, true);
    else cb(new Error('Solo se permiten archivos .csv o .xlsx.'), false);
  },
});

router.use(protect, requireOrg);

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'El identificador proporcionado no es válido.' });
  }
  next();
});

router.post('/import', restrictTo('admin'), requirePermission('payments.register'), statementUpload.single('file'), ctrl.importBankStatement);
router.get('/summary', restrictTo('admin'), requirePermission('payments.read'), ctrl.getSummary);
router.get('/', restrictTo('admin'), requirePermission('payments.read'), ctrl.getUnidentifiedPayments);
router.get('/:id', restrictTo('admin'), requirePermission('payments.read'), ctrl.getUnidentifiedPayment);
router.post('/', restrictTo('admin'), requirePermission('payments.register'), upload.array('attachments', 5), ctrl.createUnidentifiedPayment);
router.put('/:id', restrictTo('admin'), requirePermission('payments.register'), ctrl.updateUnidentifiedPayment);
router.delete('/:id', restrictTo('admin'), requirePermission('payments.cancel'), ctrl.deleteUnidentifiedPayment);
router.get('/:id/suggestions', restrictTo('admin'), requirePermission('payments.read'), ctrl.getSuggestions);
router.post('/:id/associate', restrictTo('admin'), requirePermission('payments.approve'), ctrl.associatePayment);
router.post('/:id/reject', restrictTo('admin'), requirePermission('payments.cancel'), ctrl.rejectPayment);
router.post('/:id/archive', restrictTo('admin'), requirePermission('payments.register'), ctrl.archivePayment);

module.exports = router;
