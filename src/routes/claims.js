const router        = require('express').Router();
const ctrl          = require('../controllers/claimController');
const { protect, restrictTo } = require('../middleware/auth');
const { uploadClaim } = require('../config/cloudinary');

router.use(protect);

router.get('/',    ctrl.getClaims);
router.post('/',   restrictTo('owner'), uploadClaim.array('attachments', 3), ctrl.createClaim);
router.get('/:id/attachment/:index', ctrl.getAttachment);
router.patch('/:id/status', restrictTo('admin'), ctrl.updateStatus);
router.delete('/:id', ctrl.deleteClaim);

module.exports = router;
