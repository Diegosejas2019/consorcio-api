const router          = require('express').Router();
const ctrl            = require('../controllers/noticeController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermissionForAdmin, requirePermission } = require('../middleware/permissions');
const { uploadNotice } = require('../config/cloudinary');

router.use(protect);

router.get('/',     requirePermissionForAdmin('notices.read'), ctrl.getNotices);
router.get('/:id',  requirePermissionForAdmin('notices.read'), ctrl.getNotice);
router.post('/',    restrictTo('admin'), requirePermission('notices.create'), uploadNotice.array('attachments', 3), ctrl.createNotice);
router.get('/:id/attachment/:index', ctrl.getAttachment);
router.patch('/:id/read',   ctrl.markAsRead);
router.patch('/:id/unread', ctrl.markAsUnread);
router.patch('/:id',  restrictTo('admin'), requirePermission('notices.update'), uploadNotice.array('attachments', 3), ctrl.updateNotice);
router.delete('/:id', restrictTo('admin'), requirePermission('notices.delete'), ctrl.deleteNotice);

module.exports = router;
