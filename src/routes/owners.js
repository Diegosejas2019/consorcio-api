const router = require('express').Router();
const ctrl   = require('../controllers/ownerController');
const { protect, restrictTo } = require('../middleware/auth');

// Todas las rutas requieren auth
router.use(protect);

router.get('/stats', restrictTo('admin'), ctrl.getStats);
router.get('/',      restrictTo('admin'), ctrl.getAllOwners);
router.post('/',     restrictTo('admin'), ctrl.createOwner);

router.get('/:id',    ctrl.getOwner);       // admin: cualquiera | owner: solo el suyo (verificado en ctrl)
router.patch('/:id',  restrictTo('admin'), ctrl.updateOwner);
router.delete('/:id', restrictTo('admin'), ctrl.deleteOwner);

module.exports = router;
