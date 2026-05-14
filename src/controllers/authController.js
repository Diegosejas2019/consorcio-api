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

const accessTypeFor = (membership) => (membership.role === 'admin' ? 'admin' : 'owner');

function serializeAccess(membership) {
  const accessType = accessTypeFor(membership);
  return {
    membershipId:     membership._id,
    organizationId:   membership.organization._id,
    organizationName: membership.organization.name,
    role:             normalizeRole(membership.role),
    accessType,
    adminRole:        accessType === 'admin' ? normalizeAdminRole(membership) : null,
    ownerId:          accessType === 'owner' ? membership.user : null,
  };
}

async function getActiveMemberships(userId) {
  const allMemberships = await OrganizationMember.find({ user: userId })
    .populate('organization', 'name slug businessType isActive');
  return {
    allMemberships,
    memberships: allMemberships.filter(m => m.isActive && m.organization?.isActive !== false),
  };
}

function tokenContext(userId, membership) {
  const accessType = accessTypeFor(membership);
  return {
    organizationId: membership.organization._id,
    role:           membership.role,
    membershipId:   membership._id,
    accessType,
    ownerId:        accessType === 'owner' ? userId : null,
    adminRole:      accessType === 'admin' ? normalizeAdminRole(membership) : null,
  };
}

function authData(user, membership, availableContexts = []) {
  const accessType = membership ? accessTypeFor(membership) : (isSuperAdminRole(user.role) ? 'super_admin' : normalizeRole(user.role));
  return {
    user,
    membership: membership || null,
    accessType,
    organizationId: membership?.organization?._id || user.organization?._id || user.organization || null,
    ownerId: accessType === 'owner' ? user._id : null,
    adminRole: membership ? normalizeAdminRole(membership) : (accessType === 'admin' ? 'owner_admin' : null),
    permissions: membership ? getEffectivePermissions(membership) : [],
    availableContexts,
  };
}


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

    const { allMemberships, memberships } = await getActiveMemberships(user._id);
    const availableContexts = memberships.map(serializeAccess);

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
      const membership = memberships[0];
      const m = signToken(user._id, tokenContext(user._id, membership));
      user.password = undefined;
      user.fcmToken = undefined;
      user.role     = normalizeRole(membership.role);
      logger.info(`Login exitoso: ${user.email} [${membership.role}] org=${membership.organization.name}`);
      return res.json({
        success: true,
        token: m,
        mustChangePassword: user.mustChangePassword || false,
        data: authData(user, membership, availableContexts),
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
      organizations: availableContexts,
      availableContexts,
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
    const assignedRole = req.accessType === 'admin' ? (role === 'admin' ? 'admin' : 'owner') : 'owner';
    const organizationId = req.orgId || req.user?.organization?._id || req.user?.organization;
    if (!organizationId) {
      return res.status(400).json({ success: false, message: 'Esta operacion requiere una organizacion activa.' });
    }

    const normalizedEmail = email?.toLowerCase().trim();
    let user = await User.findOne({ email: normalizedEmail }).select('+password');

    if (user && isSuperAdminRole(user.role)) {
      return res.status(400).json({ success: false, message: 'No se puede reutilizar este email para una membresia de organizacion.' });
    }

    if (!user) {
      user = await User.create({
        name,
        email: normalizedEmail,
        password,
        unit,
        phone,
        phones,
        role: assignedRole,
        organization: organizationId,
      });
      logger.info(`Nuevo usuario creado: ${user.email} [${user.role}]`);
    } else {
      const update = {};
      if (!user.name && name) update.name = name;
      if (!user.organization) update.organization = organizationId;
      if (Object.keys(update).length) {
        user = await User.findByIdAndUpdate(user._id, update, { new: true }).select('+password');
      }
      logger.info(`Usuario existente reutilizado: ${user.email} para rol ${assignedRole}`);
    }

    const existingMembership = await OrganizationMember.findOne({
      user: user._id,
      organization: organizationId,
      role: assignedRole,
    });
    if (existingMembership?.isActive) {
      return res.status(400).json({ success: false, message: 'El usuario ya tiene ese acceso activo en esta organizacion.' });
    }
    if (existingMembership) {
      existingMembership.isActive = true;
      existingMembership.deactivatedByOrganization = false;
      existingMembership.reactivatedAt = new Date();
      existingMembership.updatedBy = req.user?._id;
      if (assignedRole === 'admin') existingMembership.adminRole = existingMembership.adminRole || 'owner_admin';
      await existingMembership.save();
    } else {
      await OrganizationMember.create({
        user: user._id,
        organization: organizationId,
        role: assignedRole,
        ...(assignedRole === 'admin' ? { adminRole: 'owner_admin' } : {}),
        createdBy: req.user?._id,
      });
    }

    user.password = undefined;
    user.fcmToken = undefined;
    logger.info(`Membresia registrada: ${user.email} [${assignedRole}]`);
    sendTokenResponse(user, 201, res);
  } catch (err) {
    next(err);
  }
};

// ── GET /api/auth/me ──────────────────────────────────────────
exports.getMe = async (req, res) => {
  const user = await User.findById(req.user.id);
  const { memberships } = await getActiveMemberships(req.user.id);
  const availableContexts = memberships.map(serializeAccess);
  user.role = normalizeRole(user.role);
  if (req.membership) {
    user.role = normalizeRole(req.membership.role);
  }

  let units = [];
  if (req.accessType === 'owner' && req.membership?.organization) {
    units = await Unit.find({
      organization: req.membership.organization,
      owner: req.ownerId,
      active: true,
    }).select('name coefficient customFee');
  }

  res.json({
    success: true,
    data: {
      ...authData(user, req.membership || null, availableContexts),
      units,
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

    const token = signToken(req.user._id, tokenContext(req.user._id, membership));

    const fullUser = await User.findById(req.user._id).select('mustChangePassword');
    const { memberships } = await getActiveMemberships(req.user._id);
    const availableContexts = memberships.map(serializeAccess);
    req.user.password = undefined;
    req.user.fcmToken = undefined;
    req.user.role     = normalizeRole(membership.role);
    logger.info(`Organización seleccionada: ${req.user.email} [${membership.role}] org=${membership.organization.name}`);
    res.json({
      success: true,
      token,
      mustChangePassword: fullUser?.mustChangePassword || false,
      data: authData(req.user, membership, availableContexts),
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
      ? tokenContext(user._id, req.membership)
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
