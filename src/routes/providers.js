const router = require('express').Router();
const ctrl   = require('../controllers/providerController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { uploadProvider } = require('../config/cloudinary');

router.use(protect, restrictTo('admin'));

router.get('/',       requirePermission('providers.read'), ctrl.getProviders);
router.post('/',      requirePermission('providers.create'), uploadProvider.array('documents', 5), ctrl.createProvider);
router.patch('/:id',  requirePermission('providers.update'), uploadProvider.array('documents', 5), ctrl.updateProvider);
router.get('/:id/document/:index',    requirePermission('providers.read'), ctrl.getDocument);
router.delete('/:id/document/:index', requirePermission('providers.update'), ctrl.deleteDocument);
router.delete('/:id', requirePermission('providers.delete'), ctrl.deleteProvider);

module.exports = router;
