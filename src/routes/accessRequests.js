const router = require('express').Router();
const ctrl   = require('../controllers/accessRequestController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

// Todas las rutas requieren auth de admin
router.use(protect, restrictTo('admin'));

// Configuración del enlace de registro
router.get('/settings',           requirePermission('owners.read'),   ctrl.getJoinSettingsHandler);
router.patch('/settings',         requirePermission('owners.update'), ctrl.updateJoinSettingsHandler);
router.post('/regenerate-code',   requirePermission('owners.update'), ctrl.regenerateCodeHandler);

// CRUD de solicitudes
router.get('/',      requirePermission('owners.read'),   ctrl.listAdminRequests);
router.get('/:id',   requirePermission('owners.read'),   ctrl.getAdminRequestDetail);
router.post('/:id/approve', requirePermission('owners.create'), ctrl.approveRequest);
router.post('/:id/reject',  requirePermission('owners.update'), ctrl.rejectRequest);

module.exports = router;
