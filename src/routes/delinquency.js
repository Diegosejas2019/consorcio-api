const router = require('express').Router();
const mongoose = require('mongoose');
const ctrl = require('../controllers/delinquencyController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(protect, requireOrg, restrictTo('admin'));

router.param('ownerId', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'El identificador proporcionado no es válido.' });
  }
  next();
});

router.get('/summary', requirePermission('debt.read'), ctrl.getSummary);
router.get('/owners', requirePermission('debt.read'), ctrl.getOwners);
router.get('/aging', requirePermission('debt.read'), ctrl.getAging);
router.get('/export', requirePermission('debt.read'), ctrl.exportOwners);
router.get('/owners/:ownerId/export', requirePermission('debt.read'), ctrl.exportOwner);
router.get('/owners/:ownerId', requirePermission('debt.read'), ctrl.getOwnerDetail);
router.post('/owners/:ownerId/reminders', requirePermission('payments.remind'), ctrl.createReminder);

module.exports = router;
