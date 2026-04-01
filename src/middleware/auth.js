const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const logger = require('../config/logger');

// ── Verificar JWT ─────────────────────────────────────────────
exports.protect = async (req, res, next) => {
  try {
    // 1. Obtener token del header
    let token;
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No autorizado. Iniciá sesión para continuar.',
      });
    }

    // 2. Verificar token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      const message = err.name === 'TokenExpiredError'
        ? 'Sesión expirada. Por favor, iniciá sesión nuevamente.'
        : 'Token inválido.';
      return res.status(401).json({ success: false, message });
    }

    // 3. Verificar que el usuario siga existiendo
    const user = await User.findById(decoded.id).select('+passwordChangedAt');
    if (!user) {
      return res.status(401).json({ success: false, message: 'El usuario ya no existe.' });
    }

    // 4. Verificar cuenta activa
    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Cuenta desactivada. Contactá al administrador.' });
    }

    // 5. Verificar si la contraseña cambió después de emitir el JWT
    if (user.changedPasswordAfter(decoded.iat)) {
      return res.status(401).json({ success: false, message: 'Contraseña cambiada recientemente. Iniciá sesión nuevamente.' });
    }

    // 6. Actualizar lastLogin
    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    req.user = user;
    next();
  } catch (err) {
    logger.error('Error en middleware auth.protect:', err);
    res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
};

// ── Restricción por rol ───────────────────────────────────────
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'No tenés permisos para realizar esta acción.',
      });
    }
    next();
  };
};

// ── Propietario solo accede a sus propios datos ───────────────
exports.ownDataOnly = (paramField = 'id') => {
  return (req, res, next) => {
    if (req.user.role === 'admin') return next(); // admin puede todo
    const targetId = req.params[paramField];
    if (targetId && targetId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Solo podés acceder a tus propios datos.',
      });
    }
    next();
  };
};

// ── Generar JWT ───────────────────────────────────────────────
exports.signToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// ── Respuesta con token ───────────────────────────────────────
exports.sendTokenResponse = (user, statusCode, res) => {
  const token = exports.signToken(user._id);

  // Remover password de la respuesta
  user.password = undefined;
  user.fcmToken = undefined;

  res.status(statusCode).json({
    success: true,
    token,
    data: { user },
  });
};
