const router = require('express').Router();
const ctrl   = require('../controllers/visitController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');
const { requireFeature } = require('../middleware/features');

router.use(protect);
router.use(requireFeature('visits'));

// Rutas sin :id primero (evitan conflictos de matching)
router.get('/today',
  restrictTo('admin'),
  requirePermission('visits.read'),
  ctrl.getTodayVisits);

router.get('/history',
  restrictTo('admin'),
  requirePermission('visits.history.read'),
  ctrl.getVisitHistory);

// Rutas QR (deben ir antes de /:id para evitar conflictos de param)
router.post('/qr/:token/check-in', restrictTo('admin'), requirePermission('visits.checkIn'), ctrl.checkInByQr);
router.get('/qr/:token',           restrictTo('admin'), requirePermission('visits.read'),    ctrl.validateQrToken);

// Rutas generales
router.get('/',    requirePermissionForAdmin('visits.read'), ctrl.getVisits);
router.post('/',   restrictTo('owner'), ctrl.createVisit);

// Rutas con :id
router.post('/:id/generate-qr', restrictTo('owner'), ctrl.generateQr);

router.post('/:id/check-in',
  restrictTo('admin'),
  requirePermission('visits.checkIn'),
  ctrl.checkIn);

router.post('/:id/check-out',
  restrictTo('admin'),
  requirePermission('visits.checkOut'),
  ctrl.checkOut);

router.get('/:id/logs',
  restrictTo('admin'),
  requirePermission('visits.history.read'),
  ctrl.getVisitLogs);

router.patch('/:id/status', restrictTo('admin'), requirePermission('visits.update'), ctrl.updateStatus);
router.delete('/:id', requirePermissionForAdmin('visits.delete'), ctrl.deleteVisit);

module.exports = router;
