const router = require('express').Router();
const ctrl   = require('../controllers/employeeController');
const { protect, restrictTo } = require('../middleware/auth');
const { uploadEmployee } = require('../config/cloudinary');

router.use(protect, restrictTo('admin'));

router.get('/',      ctrl.getEmployees);
router.post('/',     uploadEmployee.array('documents', 5), ctrl.createEmployee);
router.get('/:id/document/:index',    ctrl.getDocument);
router.delete('/:id/document/:index', ctrl.deleteDocument);
router.get('/:id',   ctrl.getEmployee);
router.patch('/:id', uploadEmployee.array('documents', 5), ctrl.updateEmployee);
router.delete('/:id',ctrl.deleteEmployee);

module.exports = router;
