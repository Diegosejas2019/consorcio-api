const router = require('express').Router();
const ctrl   = require('../controllers/organizationController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

// Templates disponibles — cualquier usuario autenticado puede consultarlos
router.get('/templates', ctrl.getTemplates);

// Listar — superadmin ve todas; admin ve solo la propia
router.get('/',    restrictTo('admin', 'superadmin'), ctrl.getOrganizations);
// Detalle
router.get('/:id', restrictTo('admin', 'superadmin'), ctrl.getOrganization);
// Miembros de una org
router.get('/:id/members', restrictTo('admin', 'superadmin'), ctrl.getMembers);
// Crear — superadmin crea cualquiera; admin puede crear la propia si aún no tiene
router.post('/',   restrictTo('admin', 'superadmin'), ctrl.createOrganization);
// Actualizar — admin puede actualizar la propia; superadmin cualquiera
router.patch('/:id', restrictTo('admin', 'superadmin'), ctrl.updateOrganization);
// Desactivar — solo superadmin
router.delete('/:id', restrictTo('superadmin'), ctrl.deleteOrganization);

module.exports = router;
