const router = require('express').Router();
const mongoose = require('mongoose');
const ctrl = require('../controllers/unidentifiedPaymentController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');
const { upload } = require('../config/cloudinary');

router.use(protect);

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'El identificador proporcionado no es válido.' });
  }
  next();
});

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
