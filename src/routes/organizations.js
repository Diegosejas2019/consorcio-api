const router = require('express').Router();
const ctrl   = require('../controllers/organizationController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

// Listar — superadmin ve todas; admin ve solo la propia
router.get('/',    restrictTo('admin', 'superadmin'), ctrl.getOrganizations);
// Detalle
router.get('/:id', restrictTo('admin', 'superadmin'), ctrl.getOrganization);
// Miembros de una org
router.get('/:id/members', restrictTo('admin', 'superadmin'), ctrl.getMembers);
// Crear — solo superadmin puede crear organizaciones
router.post('/',   restrictTo('superadmin'), ctrl.createOrganization);
// Actualizar — admin puede actualizar la propia; superadmin cualquiera
router.patch('/:id', restrictTo('admin', 'superadmin'), ctrl.updateOrganization);
// Desactivar — solo superadmin
router.delete('/:id', restrictTo('superadmin'), ctrl.deleteOrganization);

module.exports = router;
