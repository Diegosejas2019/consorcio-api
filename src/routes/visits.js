const router = require('express').Router();
const ctrl   = require('../controllers/visitController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');

router.use(protect);

router.get('/',    requirePermissionForAdmin('visits.read'), ctrl.getVisits);
router.post('/',   restrictTo('owner'), ctrl.createVisit);
router.patch('/:id/status', restrictTo('admin'), requirePermission('visits.update'), ctrl.updateStatus);
router.delete('/:id', requirePermissionForAdmin('visits.delete'), ctrl.deleteVisit);

module.exports = router;
