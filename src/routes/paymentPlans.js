const router   = require('express').Router();
const mongoose = require('mongoose');
const ctrl     = require('../controllers/paymentPlanController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { upload } = require('../config/cloudinary');

router.use(protect);

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'El identificador proporcionado no es válido.' });
  }
  next();
});

// ── Owner ──────────────────────────────────────────────────────
router.post('/request', restrictTo('owner'), ctrl.requestPlan);
router.get('/my',       restrictTo('owner'), ctrl.getMyPlans);
router.post('/installments/:id/pay', restrictTo('owner'), upload.single('receipt'), ctrl.submitInstallmentPayment);

// ── Admin ──────────────────────────────────────────────────────
router.get('/admin',          restrictTo('admin'), requirePermission('paymentPlans.read'), ctrl.listPlans);
router.get('/admin/:id',      restrictTo('admin'), requirePermission('paymentPlans.read'), ctrl.getPlan);
router.post('/admin',         restrictTo('admin'), requirePermission('paymentPlans.create'), ctrl.createPlan);
router.post('/admin/:id/approve', restrictTo('admin'), requirePermission('paymentPlans.approve'), ctrl.approvePlan);
router.post('/admin/:id/reject',  restrictTo('admin'), requirePermission('paymentPlans.cancel'), ctrl.rejectPlan);
router.patch('/admin/:id/cancel', restrictTo('admin'), requirePermission('paymentPlans.cancel'), ctrl.cancelPlan);
router.delete('/admin/:id',       restrictTo('admin'), requirePermission('paymentPlans.cancel'), ctrl.deletePlan);

// ── Installments ───────────────────────────────────────────────
router.post('/admin/installments/:id/register-payment', restrictTo('admin'), requirePermission('paymentPlans.registerPayment'), ctrl.registerInstallmentPayment);

module.exports = router;
