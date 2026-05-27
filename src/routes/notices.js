const router          = require('express').Router();
const ctrl            = require('../controllers/noticeController');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermissionForAdmin, requirePermission } = require('../middleware/permissions');
const { uploadNotice } = require('../config/cloudinary');

router.use(protect);

router.get('/',     requirePermissionForAdmin('notices.read'), ctrl.getNotices);
router.post('/',    restrictTo('admin'), requirePermission('notices.create'), uploadNotice.array('attachments', 3), ctrl.createNotice);
router.post('/process-scheduled', restrictTo('admin'), requirePermission('notices.update'), ctrl.processScheduled);
router.post('/preview-recipients', restrictTo('admin'), requirePermission('notices.read'), ctrl.previewRecipients);
router.get('/:id/stats', restrictTo('admin'), requirePermission('notices.read'), ctrl.getStats);
router.get('/:id/attachment/:index', ctrl.getAttachment);
router.post('/:id/send-now', restrictTo('admin'), requirePermission('notices.update'), ctrl.sendNow);
router.post('/:id/cancel', restrictTo('admin'), requirePermission('notices.update'), ctrl.cancel);
router.get('/:id',  requirePermissionForAdmin('notices.read'), ctrl.getNotice);
router.patch('/:id/read',   ctrl.markAsRead);
router.patch('/:id/unread', ctrl.markAsUnread);
router.patch('/:id',  restrictTo('admin'), requirePermission('notices.update'), uploadNotice.array('attachments', 3), ctrl.updateNotice);
router.delete('/:id', restrictTo('admin'), requirePermission('notices.delete'), ctrl.deleteNotice);

module.exports = router;
