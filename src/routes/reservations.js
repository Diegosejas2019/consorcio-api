const router = require('express').Router();
const ctrl   = require('../controllers/reservationController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

router.get('/',    ctrl.getReservations);
router.post('/',   ctrl.createReservation);
router.patch('/:id/status', restrictTo('admin'), ctrl.updateStatus);
router.delete('/:id', ctrl.deleteReservation);

module.exports = router;
