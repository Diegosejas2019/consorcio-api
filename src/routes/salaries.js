const router = require('express').Router();
const ctrl   = require('../controllers/salaryController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect, restrictTo('admin'));

router.get('/',      ctrl.getSalaries);
router.post('/',     ctrl.createSalary);
router.get('/:id',   ctrl.getSalary);
router.patch('/:id', ctrl.updateSalary);
router.delete('/:id',ctrl.deleteSalary);

module.exports = router;
