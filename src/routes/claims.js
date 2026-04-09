const router = require('express').Router();
const ctrl   = require('../controllers/claimController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

router.get('/',    ctrl.getClaims);
router.post('/',   restrictTo('owner'), ctrl.createClaim);
router.patch('/:id/status', restrictTo('admin'), ctrl.updateStatus);
router.delete('/:id', ctrl.deleteClaim);

module.exports = router;
