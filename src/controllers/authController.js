const User   = require('../models/User');
const { signToken, sendTokenResponse } = require('../middleware/auth');
const logger = require('../config/logger');

// ── POST /api/auth/login ──────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password, fcmToken } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email y contraseña son requeridos.' });
    }

    // Buscar usuario con password (normalmente excluido)
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password +fcmToken');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Credenciales incorrectas.' });
    }

    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Cuenta desactivada. Contactá al administrador.' });
    }

    // Guardar FCM token si se proveyó (para push notifications)
    if (fcmToken && fcmToken !== user.fcmToken) {
      await User.findByIdAndUpdate(user._id, { fcmToken, lastLogin: new Date() });
    } else {
      await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });
    }

    logger.info(`Login exitoso: ${user.email} [${user.role}]`);
    sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/register (solo admin puede crear propietarios) ─
exports.register = async (req, res, next) => {
  try {
    const { name, email, password, unit, phone, role } = req.body;

    // Solo admin puede crear otros admins
    const assignedRole = req.user?.role === 'admin' ? (role || 'owner') : 'owner';

    const user = await User.create({ name, email, password, unit, phone, role: assignedRole });

    logger.info(`Nuevo usuario creado: ${user.email} [${user.role}]`);
    sendTokenResponse(user, 201, res);
  } catch (err) {
    next(err);
  }
};

// ── GET /api/auth/me ──────────────────────────────────────────
exports.getMe = async (req, res) => {
  const user = await User.findById(req.user.id);
  res.json({ success: true, data: { user } });
};

// ── PATCH /api/auth/update-password ──────────────────────────
exports.updatePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user.id).select('+password');
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(401).json({ success: false, message: 'Contraseña actual incorrecta.' });
    }

    user.password = newPassword;
    await user.save();

    sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/auth/fcm-token ─────────────────────────────────
exports.updateFcmToken = async (req, res, next) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ success: false, message: 'FCM token requerido.' });

    await User.findByIdAndUpdate(req.user.id, { fcmToken });
    res.json({ success: true, message: 'FCM token actualizado.' });
  } catch (err) {
    next(err);
  }
};
