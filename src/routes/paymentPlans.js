const router   = require('express').Router();
const mongoose = require('mongoose');
const ctrl     = require('../controllers/paymentPlanController');
const { protect, restrictTo } = require('../middleware/auth');
const { upload } = require('../config/cloudinary');

router.use(protect);

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'El identificador proporcionado no es válido.' });
  }
  next();
});

// ── Owner ──────────────────────────────────────────────────────
router.post('/request', ctrl.requestPlan);
router.get('/my',       ctrl.getMyPlans);
router.post('/installments/:id/pay', upload.single('receipt'), ctrl.submitInstallmentPayment);

// ── Admin ──────────────────────────────────────────────────────
router.get('/admin',          restrictTo('admin'), ctrl.listPlans);
router.get('/admin/:id',      restrictTo('admin'), ctrl.getPlan);
router.post('/admin',         restrictTo('admin'), ctrl.createPlan);
router.post('/admin/:id/approve', restrictTo('admin'), ctrl.approvePlan);
router.post('/admin/:id/reject',  restrictTo('admin'), ctrl.rejectPlan);
router.patch('/admin/:id/cancel', restrictTo('admin'), ctrl.cancelPlan);
router.delete('/admin/:id',       restrictTo('admin'), ctrl.deletePlan);

// ── Installments ───────────────────────────────────────────────
router.post('/admin/installments/:id/register-payment', restrictTo('admin'), ctrl.registerInstallmentPayment);

module.exports = router;
