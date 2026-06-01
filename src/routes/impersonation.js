const router = require('express').Router();
const ctrl   = require('../controllers/impersonationController');
const { protect, restrictTo } = require('../middleware/auth');

router.use(protect, restrictTo('super_admin'));

router.get('/users',      ctrl.searchUsers);
router.post('/start',     ctrl.startSession);
router.post('/stop',      ctrl.stopSession);
router.get('/sessions',   ctrl.listSessions);

module.exports = router;
