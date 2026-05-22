const router = require('express').Router();
const ctrl   = require('../controllers/accessRequestController');
const { protect } = require('../middleware/auth');

// Rutas públicas — protegidas solo por joinLimiter (aplicado en app.js)
router.get('/:code', ctrl.getOrgByJoinCode);
router.post('/:code', ctrl.submitPublicRequest);

// Solicitud autenticada (usuario que ya tiene cuenta)
router.post('/:code/auth', protect, ctrl.submitAuthenticatedRequest);

module.exports = router;
