const router = require('express').Router();
const ctrl   = require('../controllers/reservationController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../middleware/features');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');

router.use(protect, requireOrg, requireFeature('reservations'));

router.get('/',    requirePermissionForAdmin('reservations.read'), ctrl.getReservations);
router.post('/',   restrictTo('owner'), ctrl.createReservation);
router.patch('/:id/status', restrictTo('admin'), requirePermission('reservations.update'), ctrl.updateStatus);
router.delete('/:id', requirePermissionForAdmin('reservations.delete'), ctrl.deleteReservation);

module.exports = router;
