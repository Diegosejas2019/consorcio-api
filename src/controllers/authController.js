const crypto             = require('crypto');
const User               = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Unit               = require('../models/Unit');
const { signToken, signSelectionToken, sendTokenResponse } = require('../middleware/auth');
const { sendPasswordReset } = require('../services/emailService');
const { normalizeRole, isSuperAdminRole } = require('../utils/roles');
const { getEffectivePermissions, normalizeAdminRole } = require('../utils/adminPermissions');
const logger = require('../config/logger');

const markLogin = (userId, extra = {}) =>
  User.findByIdAndUpdate(userId, { ...extra, lastLogin: new Date(), lastLoginAt: new Date() });


// ── POST /api/auth/login ──────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password, fcmToken } = req.body;

    logger.info(`[Login] body recibido: email=${email}, fcmToken=${fcmToken || 'NO ENVIADO'}`);

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email y contraseña son requeridos.' });
    }

    // Buscar usuario con password (normalmente excluido)
    const user = await User.findOne({ email: email.toLowerCase() })
      .select('+password +fcmToken')
      .populate('organization', 'isActive');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Credenciales incorrectas.' });
    }

    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Cuenta desactivada. Contactá al administrador.' });
    }

    // Guardar FCM token si se proveyó (para push notifications)
    if (fcmToken && fcmToken !== user.fcmToken) {
      await markLogin(user._id, { fcmToken });
    } else {
      await markLogin(user._id);
    }

    // Buscar membresías activas del usuario
    user.role = normalizeRole(user.role);

    // SuperAdmin es global: no selecciona organizacion ni usa memberships.
    if (isSuperAdminRole(user.role)) {
      logger.info(`Login exitoso global: ${user.email} [${user.role}]`);
      return sendTokenResponse(user, 200, res);
    }

    const allMemberships = await OrganizationMember.find({ user: user._id })
      .populate('organization', 'name slug businessType isActive');
    const memberships = allMemberships.filter(m => m.isActive && m.organization?.isActive !== false);

    // Sin membresías → superadmin u owner legacy sin OrganizationMember (backward compat)
    if (memberships.length === 0) {
      if (allMemberships.some(m => m.organization?.isActive === false) || user.organization?.isActive === false) {
        return res.status(403).json({
          success: false,
          message: 'Tu organizacion se encuentra desactivada. Contacta al soporte de Gestionar.',
        });
      }
      logger.info(`Login exitoso (sin membresía): ${user.email} [${user.role}]`);
      return sendTokenResponse(user, 200, res);
    }

    if (memberships.length === 1) {
      const m = signToken(user._id, {
        organizationId: memberships[0].organization._id,
        role:           memberships[0].role,
        membershipId:   memberships[0]._id,
      });
      const membership = memberships[0];
      user.password = undefined;
      user.fcmToken = undefined;
      user.role     = normalizeRole(membership.role);
      logger.info(`Login exitoso: ${user.email} [${membership.role}] org=${membership.organization.name}`);
      return res.json({
        success: true,
        token: m,
        mustChangePassword: user.mustChangePassword || false,
        data: {
          user,
          membership,
          adminRole: normalizeAdminRole(membership),
          permissions: getEffectivePermissions(membership),
        },
      });
    }

    // Múltiples membresías → pedir selección de organización
    const selectionToken = signSelectionToken(user._id);
    logger.info(`Login multi-org: ${user.email} (${memberships.length} organizaciones)`);
    return res.json({
      success:                       true,
      requiresOrganizationSelection: true,
      selectionToken,
      mustChangePassword: user.mustChangePassword || false,
      organizations: memberships.map(m => ({
        membershipId:     m._id,
        organizationId:   m.organization._id,
        organizationName: m.organization.name,
        role:             normalizeRole(m.role),
        adminRole:        normalizeAdminRole(m),
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/register (solo admin puede crear propietarios) ─
exports.register = async (req, res, next) => {
  try {
    const { name, email, password, unit, phone, phones, role } = req.body;

    // Solo admin puede crear otros admins (nunca superadmin via API)
    const assignedRole = req.user?.role === 'admin' ? (role === 'admin' ? 'admin' : 'owner') : 'owner';

    const user = await User.create({
      name, email, password, unit, phone, phones,
      role: assignedRole,
      organization: req.user?.organization?._id ?? req.user?.organization ?? undefined,
    });

    logger.info(`Nuevo usuario creado: ${user.email} [${user.role}]`);
    sendTokenResponse(user, 201, res);
  } catch (err) {
    next(err);
  }
};

// ── GET /api/auth/me ──────────────────────────────────────────
exports.getMe = async (req, res) => {
  const user = await User.findById(req.user.id);
  user.role = normalizeRole(user.role);
  if (req.membership) {
    user.role = normalizeRole(req.membership.role);
  }

  let units = [];
  if (req.membership && req.membership.role === 'owner' && req.membership.organization) {
    units = await Unit.find({
      organization: req.membership.organization,
      owner: req.user.id,
      active: true,
    }).select('name coefficient customFee');
  }

  res.json({
    success: true,
    data: {
      user,
      membership: req.membership || null,
      units,
      adminRole: req.membership ? normalizeAdminRole(req.membership) : (user.role === 'admin' ? 'owner_admin' : null),
      permissions: req.membership ? getEffectivePermissions(req.membership) : [],
    },
  });
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

// ── POST /api/auth/forgot-password ───────────────────────────
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    // Respuesta genérica siempre para no revelar si el email existe
    const genericResponse = res.json.bind(res, {
      success: true,
      message: 'Si ese email está registrado recibirás un enlace en los próximos minutos.',
    });

    const user = await User.findOne({ email: email?.toLowerCase(), isActive: true });
    if (!user) {
      logger.info(`[ForgotPassword] Email no encontrado o inactivo: ${email}`);
      return genericResponse();
    }

    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.APP_BASE_URL}/reset-password?token=${resetToken}`;

    try {
      await sendPasswordReset(user, resetUrl);
      logger.info(`[ForgotPassword] Email de reset enviado a ${user.email}`);
    } catch (emailErr) {
      // Revertir token si el email falla — no dejar tokens huérfanos
      user.passwordResetToken   = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: false });
      logger.error(`[ForgotPassword] Error enviando email a ${user.email}: ${emailErr.message}`);
      return next(emailErr);
    }

    genericResponse();
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/reset-password/:token ─────────────────────
exports.resetPassword = async (req, res, next) => {
  try {
    const { newPassword } = req.body;

    // Hashear el token de la URL para comparar con el de la DB
    const hashedToken = crypto
      .createHash('sha256')
      .update(req.params.token)
      .digest('hex');

    const user = await User.findOne({
      passwordResetToken:   hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select('+passwordResetToken +passwordResetExpires');

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'El enlace de restablecimiento es inválido o ya expiró.',
      });
    }

    // Actualizar contraseña y limpiar campos de reset
    user.password             = newPassword;
    user.mustChangePassword   = false;
    user.passwordResetToken   = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    logger.info(`[ResetPassword] Contraseña restablecida para ${user.email}`);

    // Loguear automáticamente al usuario con un token nuevo
    sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/select-organization ───────────────────────
exports.selectOrganization = async (req, res, next) => {
  try {
    const { membershipId } = req.body;

    if (isSuperAdminRole(req.user.role)) {
      return res.status(400).json({
        success: false,
        message: 'El SuperAdmin es global y no selecciona organizacion.',
      });
    }

    const membership = await OrganizationMember.findOne({
      _id:      membershipId,
      user:     req.user._id,
      isActive: true,
    }).populate('organization', '-mpPublicKey -mpAccessToken -mpWebhookSecret');

    if (!membership) {
      return res.status(400).json({ success: false, message: 'Membresía no válida.' });
    }

    if (membership.organization?.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Tu organizacion se encuentra desactivada. Contacta al soporte de Gestionar.',
      });
    }

    const token = signToken(req.user._id, {
      organizationId: membership.organization._id,
      role:           membership.role,
      membershipId:   membership._id,
    });

    const fullUser = await User.findById(req.user._id).select('mustChangePassword');
    req.user.password = undefined;
    req.user.fcmToken = undefined;
    req.user.role     = normalizeRole(membership.role);
    logger.info(`Organización seleccionada: ${req.user.email} [${membership.role}] org=${membership.organization.name}`);
    res.json({
      success: true,
      token,
      mustChangePassword: fullUser?.mustChangePassword || false,
      data: {
        user: req.user,
        membership,
        adminRole: normalizeAdminRole(membership),
        permissions: getEffectivePermissions(membership),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/change-temporary-password ──────────────────
exports.changeTempPassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword) {
      return res.status(400).json({ success: false, message: 'La contraseña actual es obligatoria.' });
    }
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Las contraseñas no coinciden.' });
    }

    const user = await User.findById(req.user.id).select('+password');
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(401).json({ success: false, message: 'La contraseña actual es incorrecta.' });
    }
    if (await user.comparePassword(newPassword)) {
      return res.status(400).json({ success: false, message: 'La nueva contraseña no puede ser igual a la contraseña temporal.' });
    }

    user.password = newPassword;
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    await user.save();

    // Emitir nuevo token para que el JWT no quede invalidado por passwordChangedAt
    const orgContext = req.membership
      ? {
          organizationId: req.membership.organization._id,
          role:           req.membership.role,
          membershipId:   req.membership._id,
        }
      : null;
    const newToken = signToken(user._id, orgContext);

    logger.info(`[ChangeTempPassword] Contraseña temporal cambiada para ${user.email}`);
    res.json({
      success:  true,
      token:    newToken,
      message:  'Contraseña cambiada correctamente. Ya podés usar la aplicación.',
    });
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
