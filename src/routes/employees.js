const router = require('express').Router();
const ctrl   = require('../controllers/employeeController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { uploadEmployee } = require('../config/cloudinary');

router.use(protect, restrictTo('admin'));

router.get('/',      requirePermission('employees.read'), ctrl.getEmployees);
router.post('/',     requirePermission('employees.create'), uploadEmployee.array('documents', 5), ctrl.createEmployee);
router.get('/:id/document/:index',    requirePermission('employees.read'), ctrl.getDocument);
router.delete('/:id/document/:index', requirePermission('employees.update'), ctrl.deleteDocument);
router.get('/:id',   requirePermission('employees.read'), ctrl.getEmployee);
router.patch('/:id', requirePermission('employees.update'), uploadEmployee.array('documents', 5), ctrl.updateEmployee);
router.delete('/:id',requirePermission('employees.delete'), ctrl.deleteEmployee);

module.exports = router;
