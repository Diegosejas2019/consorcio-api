const router = require('express').Router();
const ctrl   = require('../controllers/spaceController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

router.get('/',     ctrl.getSpaces);
router.post('/',    restrictTo('admin'), ctrl.createSpace);
router.patch('/:id', restrictTo('admin'), ctrl.updateSpace);
router.delete('/:id', restrictTo('admin'), ctrl.deleteSpace);

module.exports = router;
