const router = require('express').Router();
const ctrl   = require('../controllers/adminAgendaController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(protect, restrictTo('admin'), requireOrg);

router.get('/',                     requirePermission('dashboard.read'), ctrl.getAgenda);
router.post('/tasks',               requirePermission('dashboard.read'), ctrl.createTask);
router.patch('/tasks/:id/complete', requirePermission('dashboard.read'), ctrl.completeTask);
router.delete('/tasks/:id',         requirePermission('dashboard.read'), ctrl.deleteTask);

module.exports = router;
