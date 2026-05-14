const router = require('express').Router();
const ctrl   = require('../controllers/reservationController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');

router.use(protect);

router.get('/',    requirePermissionForAdmin('reservations.read'), ctrl.getReservations);
router.post('/',   restrictTo('owner'), ctrl.createReservation);
router.patch('/:id/status', restrictTo('admin'), requirePermission('reservations.update'), ctrl.updateStatus);
router.delete('/:id', requirePermissionForAdmin('reservations.delete'), ctrl.deleteReservation);

module.exports = router;
