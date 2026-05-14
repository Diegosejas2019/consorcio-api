const router = require('express').Router();
const ctrl   = require('../controllers/salaryController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(protect, requireOrg, restrictTo('admin'));

router.get('/',      requirePermission('salaries.read'), ctrl.getSalaries);
router.post('/',     requirePermission('salaries.create'), ctrl.createSalary);
router.get('/:id',   requirePermission('salaries.read'), ctrl.getSalary);
router.patch('/:id', requirePermission('salaries.update'), ctrl.updateSalary);
router.delete('/:id',requirePermission('salaries.delete'), ctrl.deleteSalary);

module.exports = router;
