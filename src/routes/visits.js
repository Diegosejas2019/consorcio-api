const router = require('express').Router();
const ctrl   = require('../controllers/visitController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

router.get('/',    ctrl.getVisits);
router.post('/',   restrictTo('owner'), ctrl.createVisit);
router.patch('/:id/status', restrictTo('admin'), ctrl.updateStatus);
router.delete('/:id', ctrl.deleteVisit);

module.exports = router;
