const router          = require('express').Router();
const ctrl            = require('../controllers/noticeController');
const { protect, restrictTo } = require('../middleware/auth');
const { uploadNotice } = require('../config/cloudinary');

router.use(protect);

router.get('/',     ctrl.getNotices);
router.get('/:id',  ctrl.getNotice);
router.post('/',    restrictTo('admin'), uploadNotice.array('attachments', 3), ctrl.createNotice);
router.get('/:id/attachment/:index', ctrl.getAttachment);
router.patch('/:id/read',   ctrl.markAsRead);
router.patch('/:id/unread', ctrl.markAsUnread);
router.patch('/:id',  restrictTo('admin'), uploadNotice.array('attachments', 3), ctrl.updateNotice);
router.delete('/:id', restrictTo('admin'), ctrl.deleteNotice);

module.exports = router;
