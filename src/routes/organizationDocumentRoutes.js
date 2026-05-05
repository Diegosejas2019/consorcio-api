const router = require('express').Router();
const ctrl = require('../controllers/organizationDocumentController');
const { protect, requireOrg, restrictTo } = require('../middleware/auth');
const { uploadOrganizationDocument } = require('../config/cloudinary');

router.use(protect, requireOrg);

router.get('/', ctrl.getDocuments);
router.post('/', restrictTo('admin'), uploadOrganizationDocument.single('file'), ctrl.createDocument);
router.get('/:id', ctrl.getDocument);
router.patch('/:id', restrictTo('admin'), uploadOrganizationDocument.single('file'), ctrl.updateDocument);
router.delete('/:id', restrictTo('admin'), ctrl.deleteDocument);
router.get('/:id/download', ctrl.getDocumentUrl);

module.exports = router;
