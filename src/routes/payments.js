const router = require('express').Router();
const ctrl   = require('../controllers/paymentController');
const { protect, restrictTo } = require('../middleware/auth');
const { upload } = require('../config/cloudinary');

router.use(protect);

router.get('/dashboard', restrictTo('admin'), ctrl.getDashboard);
router.get('/',          ctrl.getPayments);
router.post('/',         upload.single('receipt'), ctrl.createPayment);
router.get('/:id/receipt', ctrl.getReceipt);
router.get('/:id',         ctrl.getPayment);
router.delete('/:id',      ctrl.deletePayment);

// Solo admin puede aprobar/rechazar
router.patch('/:id/approve', restrictTo('admin'), ctrl.approvePayment);
router.patch('/:id/reject',  restrictTo('admin'), ctrl.rejectPayment);

// Trigger manual de recordatorios (admin)
router.post('/send-reminders', restrictTo('admin'), ctrl.sendReminders);

module.exports = router;
