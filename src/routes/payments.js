const router = require('express').Router();
const mongoose = require('mongoose');
const ctrl   = require('../controllers/paymentController');
const { protect, restrictTo } = require('../middleware/auth');
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

router.get('/dashboard',       restrictTo('admin'), ctrl.getDashboard);
router.get('/available-items', ctrl.getAvailableItems);
router.get('/',                ctrl.getPayments);
router.post('/',         upload.single('receipt'), ctrl.createPayment);
router.get('/:id/receipt',        ctrl.getReceipt);
router.get('/:id/system-receipt', ctrl.getSystemReceipt);
router.get('/:id',                ctrl.getPayment);
router.delete('/:id',      ctrl.deletePayment);

// Solo admin puede aprobar/rechazar/reenviar recibo
router.patch('/:id/approve',       restrictTo('admin'), ctrl.approvePayment);
router.patch('/:id/reject',        restrictTo('admin'), ctrl.rejectPayment);
router.post('/:id/resend-receipt', restrictTo('admin'), ctrl.resendReceipt);

// Trigger manual de recordatorios (admin)
router.post('/send-reminders', restrictTo('admin'), ctrl.sendReminders);

module.exports = router;
