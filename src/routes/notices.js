const router = require('express').Router();
const ctrl   = require('../controllers/noticeController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect);

router.get('/',     ctrl.getNotices);
router.get('/:id',  ctrl.getNotice);
router.post('/',    restrictTo('admin'), ctrl.createNotice);
router.patch('/:id/read',   ctrl.markAsRead);
router.patch('/:id/unread', ctrl.markAsUnread);
router.patch('/:id',  restrictTo('admin'), ctrl.updateNotice);
router.delete('/:id', restrictTo('admin'), ctrl.deleteNotice);

module.exports = router;
