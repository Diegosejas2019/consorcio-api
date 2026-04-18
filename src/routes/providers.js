const router = require('express').Router();
const ctrl   = require('../controllers/providerController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect, restrictTo('admin'));

router.get('/',     ctrl.getProviders);
router.post('/',    ctrl.createProvider);
router.patch('/:id',  ctrl.updateProvider);
router.delete('/:id', ctrl.deleteProvider);

module.exports = router;
