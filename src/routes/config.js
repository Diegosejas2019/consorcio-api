const router = require('express').Router();
const ctrl   = require('../controllers/configController');
const { protect, restrictTo } = require('../middleware/auth');

router.get('/',    protect, ctrl.getConfig);
router.patch('/',  protect, restrictTo('admin'), ctrl.updateConfig);

module.exports = router;
