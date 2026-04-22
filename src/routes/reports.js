const router = require('express').Router();
const ctrl   = require('../controllers/reportController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);
router.use(restrictTo('admin'));

router.get('/monthly-summary', ctrl.getMonthlySummary);
router.get('/expensas-pdf',    ctrl.getExpensasPdf);

module.exports = router;
