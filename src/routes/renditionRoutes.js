const router = require('express').Router();
const ctrl   = require('../controllers/renditionController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(protect);
router.use(requireOrg);
router.use(restrictTo('admin'), requirePermission('reports.read'));

router.get('/preview',                     ctrl.getPreview);
router.get('/history',                     ctrl.getHistory);
router.get('/annual',                      ctrl.getAnnual);
router.post('/:period/generate-pdf',       ctrl.generatePdf);
router.get('/:period/export-csv',          ctrl.exportCsv);
router.patch('/:period/observations',      ctrl.saveObservations);

module.exports = router;
