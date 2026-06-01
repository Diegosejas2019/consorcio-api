const router = require('express').Router();
const ctrl   = require('../controllers/salaryController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { blockOnImpersonation } = require('../middleware/impersonation');

router.use(protect, requireOrg, restrictTo('admin'));

router.get('/',      requirePermission('salaries.read'), ctrl.getSalaries);
router.post('/',     blockOnImpersonation, requirePermission('salaries.create'), ctrl.createSalary);
router.get('/:id',   requirePermission('salaries.read'), ctrl.getSalary);
router.patch('/:id', blockOnImpersonation, requirePermission('salaries.update'), ctrl.updateSalary);
router.delete('/:id',blockOnImpersonation, requirePermission('salaries.delete'), ctrl.deleteSalary);

module.exports = router;
