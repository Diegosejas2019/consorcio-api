const router      = require('express').Router();
const ctrl        = require('../controllers/organizationController');
const featureCtrl = require('../controllers/featureController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermissionForAdmin } = require('../middleware/permissions');

router.use(protect);

// Templates disponibles — cualquier usuario autenticado puede consultarlos
router.get('/templates', ctrl.getTemplates);

// Listar — superadmin ve todas; admin ve solo la propia
router.get('/',    restrictTo('admin', 'superadmin'), requirePermissionForAdmin('settings.read'), ctrl.getOrganizations);
// Detalle
router.get('/:id', restrictTo('admin', 'superadmin'), requirePermissionForAdmin('settings.read'), ctrl.getOrganization);
// Miembros de una org
router.get('/:id/members', restrictTo('admin', 'superadmin'), requirePermissionForAdmin('admins.read'), ctrl.getMembers);
// Features — GET: cualquier miembro de la org; PUT: solo superadmin
router.get('/:id/features', featureCtrl.getFeatures);
router.put('/:id/features', restrictTo('superadmin'), featureCtrl.updateFeatures);
// Crear — superadmin crea cualquiera; admin puede crear la propia si aún no tiene
router.post('/',   restrictTo('admin', 'superadmin'), requirePermissionForAdmin('settings.update'), ctrl.createOrganization);
// Actualizar — admin puede actualizar la propia; superadmin cualquiera
router.patch('/:id', restrictTo('admin', 'superadmin'), requirePermissionForAdmin('settings.update'), ctrl.updateOrganization);
// Desactivar — solo superadmin
router.delete('/:id', restrictTo('superadmin'), ctrl.deleteOrganization);

module.exports = router;
