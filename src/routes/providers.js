const router = require('express').Router();
const ctrl   = require('../controllers/providerController');
const { protect, restrictTo } = require('../middleware/auth');
const { uploadProvider } = require('../config/cloudinary');

router.use(protect, restrictTo('admin'));

router.get('/',       ctrl.getProviders);
router.post('/',      uploadProvider.array('documents', 5), ctrl.createProvider);
router.patch('/:id',  uploadProvider.array('documents', 5), ctrl.updateProvider);
router.get('/:id/document/:index',    ctrl.getDocument);
router.delete('/:id/document/:index', ctrl.deleteDocument);
router.delete('/:id', ctrl.deleteProvider);

module.exports = router;
