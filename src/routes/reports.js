const router = require('express').Router();
const ctrl   = require('../controllers/reportController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(protect);
router.use(restrictTo('admin'), requirePermission('reports.read'));

router.get('/monthly-summary', ctrl.getMonthlySummary);
router.get('/expensas-pdf',    ctrl.getExpensasPdf);

module.exports = router;
