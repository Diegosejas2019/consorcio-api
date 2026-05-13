const router   = require('express').Router();
const mongoose = require('mongoose');
const ctrl     = require('../controllers/paymentPlanController');
const { protect, restrictTo } = require('../middleware/auth');

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

// ── Admin ──────────────────────────────────────────────────────
router.get('/admin',          restrictTo('admin'), ctrl.listPlans);
router.get('/admin/:id',      restrictTo('admin'), ctrl.getPlan);
router.post('/admin',         restrictTo('admin'), ctrl.createPlan);
router.post('/admin/:id/approve', restrictTo('admin'), ctrl.approvePlan);
router.post('/admin/:id/reject',  restrictTo('admin'), ctrl.rejectPlan);
router.patch('/admin/:id/cancel', restrictTo('admin'), ctrl.cancelPlan);

// ── Installments ───────────────────────────────────────────────
router.post('/admin/installments/:id/register-payment', restrictTo('admin'), ctrl.registerInstallmentPayment);

module.exports = router;
