const router = require('express').Router();
const ctrl = require('../controllers/noticeTemplateController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

router.use(protect);
router.use(restrictTo('admin'));

router.get('/', requirePermission('notices.read'), ctrl.getTemplates);
router.post('/', requirePermission('notices.create'), ctrl.createTemplate);
router.patch('/:id', requirePermission('notices.update'), ctrl.updateTemplate);
router.put('/:id', requirePermission('notices.update'), ctrl.updateTemplate);
router.delete('/:id', requirePermission('notices.delete'), ctrl.deleteTemplate);

module.exports = router;
