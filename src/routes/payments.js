const router = require('express').Router();
const mongoose = require('mongoose');
const ctrl   = require('../controllers/paymentController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');
const { upload } = require('../config/cloudinary');

router.use(protect);

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({
      success: false,
      message: 'El identificador proporcionado no es valido.',
    });
  }
  next();
});

router.get('/dashboard',       restrictTo('admin'), requirePermission('dashboard.read'), ctrl.getDashboard);
router.get('/admin/owners',    restrictTo('admin'), requirePermission('payments.read'), ctrl.getAdminOwnersPayments);
router.get('/available-items', ctrl.getAvailableItems);
router.get('/',                requirePermissionForAdmin('payments.read'), ctrl.getPayments);
router.post('/',         requirePermissionForAdmin('payments.register'), upload.single('receipt'), ctrl.createPayment);
router.get('/:id/receipt',        ctrl.getReceipt);
router.get('/:id/system-receipt', ctrl.getSystemReceipt);
router.get('/:id',                requirePermissionForAdmin('payments.read'), ctrl.getPayment);
router.delete('/:id',      requirePermissionForAdmin('payments.cancel'), ctrl.deletePayment);

// Solo admin puede aprobar/rechazar/reenviar recibo
router.patch('/:id/approve',       restrictTo('admin'), requirePermission('payments.approve'), ctrl.approvePayment);
router.patch('/:id/reject',        restrictTo('admin'), requirePermission('payments.cancel'), ctrl.rejectPayment);
router.post('/:id/resend-receipt', restrictTo('admin'), requirePermission('receipts.download'), ctrl.resendReceipt);

// Trigger manual de recordatorios (admin)
router.post('/send-reminders', restrictTo('admin'), requirePermission('payments.remind'), ctrl.sendReminders);

module.exports = router;
