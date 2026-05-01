const router = require('express').Router();
const ctrl   = require('../controllers/employeeController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect, restrictTo('admin'));

router.get('/',      ctrl.getEmployees);
router.post('/',     ctrl.createEmployee);
router.get('/:id',   ctrl.getEmployee);
router.patch('/:id', ctrl.updateEmployee);
router.delete('/:id',ctrl.deleteEmployee);

module.exports = router;
