const router = require('express').Router();
const ctrl = require('../controllers/noticeTemplateController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requireFeature } = require('../middleware/features');
const { requirePermission } = require('../middleware/permissions');

router.use(protect, requireOrg, requireFeature('notices'));
router.use(restrictTo('admin'));

router.get('/', requirePermission('notices.read'), ctrl.getTemplates);
router.post('/', requirePermission('notices.create'), ctrl.createTemplate);
router.patch('/:id', requirePermission('notices.update'), ctrl.updateTemplate);
router.put('/:id', requirePermission('notices.update'), ctrl.updateTemplate);
router.delete('/:id', requirePermission('notices.delete'), ctrl.deleteTemplate);

module.exports = router;
