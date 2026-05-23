const router = require('express').Router();
const ctrl   = require('../controllers/reportController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(protect);
router.use(restrictTo('admin'), requirePermission('reports.read'));

// Existentes
router.get('/monthly-summary',      ctrl.getMonthlySummary);
router.get('/expensas-pdf',         ctrl.getExpensasPdf);

// Nuevos
router.post('/owner-statement',     ctrl.ownerStatementHandler);
router.post('/owner-statement/pdf', ctrl.ownerStatementPdfHandler);
router.post('/delinquency',         ctrl.delinquencyReportHandler);
router.post('/payments',            ctrl.paymentsReportHandler);
router.post('/expenses',            ctrl.expensesReportHandler);
router.post('/owners',              ctrl.ownersReportHandler);

module.exports = router;
