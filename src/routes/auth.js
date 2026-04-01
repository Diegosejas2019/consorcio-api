const router = require('express').Router();
const { body } = require('express-validator');
const ctrl   = require('../controllers/authController');
const { protect, restrictTo } = require('../middleware/auth');
const validate = require('../middleware/validate');

router.post('/login',
  [
    body('email').isEmail().withMessage('Email inválido').normalizeEmail(),
    body('password').notEmpty().withMessage('Contraseña requerida'),
  ],
  validate,
  ctrl.login
);

// Solo admin puede registrar nuevos usuarios
router.post('/register',
  protect, restrictTo('admin'),
  [
    body('name').trim().notEmpty().withMessage('Nombre requerido'),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Mínimo 6 caracteres'),
  ],
  validate,
  ctrl.register
);

router.get('/me',            protect, ctrl.getMe);
router.patch('/update-password', protect, ctrl.updatePassword);
router.patch('/fcm-token',   protect, ctrl.updateFcmToken);

module.exports = router;
