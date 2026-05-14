const router = require('express').Router();
const OrganizationFeature = require('../models/OrganizationFeature');
const ctrl = require('../controllers/organizationDocumentController');
const { protect, requireOrg, restrictTo } = require('../middleware/auth');
const { requirePermissionForAdmin, requirePermission } = require('../middleware/permissions');
const { uploadOrganizationDocument } = require('../config/cloudinary');

async function requireDocumentsFeature(req, res, next) {
  try {
    const feature = await OrganizationFeature.findOne({
      organization: req.orgId,
      featureKey:   'documents',
    }).select('enabled');

    if (feature && feature.enabled === false) {
      return res.status(403).json({
        success: false,
        message: 'El modulo de documentacion no esta habilitado para esta organizacion.',
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}

router.use(protect, requireOrg);
router.use(requireDocumentsFeature);

router.get('/', requirePermissionForAdmin('documents.read'), ctrl.getDocuments);
router.post('/', restrictTo('admin'), requirePermission('documents.create'), uploadOrganizationDocument.single('file'), ctrl.createDocument);
router.get('/:id', requirePermissionForAdmin('documents.read'), ctrl.getDocument);
router.patch('/:id', restrictTo('admin'), requirePermission('documents.update'), uploadOrganizationDocument.single('file'), ctrl.updateDocument);
router.delete('/:id', restrictTo('admin'), requirePermission('documents.delete'), ctrl.deleteDocument);
router.get('/:id/download', requirePermissionForAdmin('documents.read'), ctrl.getDocumentUrl);

module.exports = router;
