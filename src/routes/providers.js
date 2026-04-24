const router = require('express').Router();
const ctrl   = require('../controllers/providerController');
const { protect, restrictTo } = require('../middleware/auth');
const { uploadProvider } = require('../config/cloudinary');

router.use(protect, restrictTo('admin'));

router.get('/',       ctrl.getProviders);
router.post('/',      uploadProvider.single('document'), ctrl.createProvider);
router.patch('/:id',  uploadProvider.single('document'), ctrl.updateProvider);
router.delete('/:id', ctrl.deleteProvider);

module.exports = router;
