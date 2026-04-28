const jwt                = require('jsonwebtoken');
const User               = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const logger             = require('../config/logger');

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

    // 3. Rechazar selectionTokens — son solo para /select-organization
    if (decoded.pendingOrgSelection) {
      return res.status(401).json({
        success: false,
        message: 'Debe seleccionar una organización antes de continuar.',
      });
    }

    // 4. Verificar que el usuario siga existiendo (popular organización)
    const user = await User.findById(decoded.id)
      .select('+passwordChangedAt')
      .populate('organization', '-mpPublicKey -mpAccessToken -mpWebhookSecret');

    if (!user) {
      return res.status(401).json({ success: false, message: 'El usuario ya no existe.' });
    }

    // 5. Verificar cuenta activa
    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Cuenta desactivada. Contactá al administrador.' });
    }

    // 6. Verificar si la contraseña cambió después de emitir el JWT
    if (user.changedPasswordAfter(decoded.iat)) {
      return res.status(401).json({ success: false, message: 'Contraseña cambiada recientemente. Iniciá sesión nuevamente.' });
    }

    // 7. Actualizar lastLogin
    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    req.user = user;

    // Contexto de organización: desde membershipId del token (nuevo) o user.organization (legacy)
    if (decoded.membershipId) {
      const membership = await OrganizationMember.findById(decoded.membershipId)
        .populate('organization', '-mpPublicKey -mpAccessToken -mpWebhookSecret');
      if (membership && membership.isActive) {
        req.membership = membership;
        req.orgId      = membership.organization._id;
        req.org        = membership.organization;
        req.user.role  = membership.role;
      }
    } else {
      req.orgId = user.organization?._id ?? null;
      req.org   = user.organization ?? null;
    }

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

// ── Requerir contexto de organización ────────────────────────
// Bloquea requests de superadmin o usuarios sin org asignada
// cuando el endpoint necesita un tenant específico.
exports.requireOrg = (req, res, next) => {
  if (!req.orgId) {
    return res.status(400).json({
      success: false,
      message: 'Esta operación requiere contexto de organización.',
    });
  }
  next();
};

// ── Propietario solo accede a sus propios datos ───────────────
exports.ownDataOnly = (paramField = 'id') => {
  return (req, res, next) => {
    if (req.user.role === 'admin' || req.user.role === 'superadmin') return next();
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
exports.signToken = (userId, orgContext = null) => {
  const payload = { id: userId };
  if (orgContext) {
    payload.organizationId = orgContext.organizationId;
    payload.role           = orgContext.role;
    payload.membershipId   = orgContext.membershipId;
  }
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// ── Token temporal para selección de organización (10 min) ───
exports.signSelectionToken = (userId) =>
  jwt.sign({ id: userId, pendingOrgSelection: true }, process.env.JWT_SECRET, { expiresIn: '10m' });

// ── Middleware exclusivo para /select-organization ────────────
// Acepta solo selectionTokens (pendingOrgSelection: true)
exports.protectSelection = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
      return res.status(401).json({ success: false, message: 'No autorizado. Iniciá sesión para continuar.' });
    }
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      const message = err.name === 'TokenExpiredError'
        ? 'El proceso de selección expiró. Iniciá sesión nuevamente.'
        : 'Token inválido.';
      return res.status(401).json({ success: false, message });
    }
    if (!decoded.pendingOrgSelection) {
      return res.status(401).json({ success: false, message: 'Token no válido para esta operación.' });
    }
    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'El usuario ya no existe o está desactivado.' });
    }
    req.user = user;
    next();
  } catch (err) {
    logger.error('Error en middleware auth.protectSelection:', err);
    res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
};

// ── Respuesta con token ───────────────────────────────────────
exports.sendTokenResponse = (user, statusCode, res) => {
  const token = exports.signToken(user._id);

  // Remover campos sensibles de la respuesta
  user.password = undefined;
  user.fcmToken = undefined;

  res.status(statusCode).json({
    success: true,
    token,
    data: { user },
  });
};
