const crypto = require('crypto');
const User = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const { sendAdminWelcome } = require('../services/emailService');
const logger = require('../config/logger');
const {
  ADMIN_ROLE_LABELS,
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  getEffectivePermissions,
  normalizeAdminRole,
} = require('../utils/adminPermissions');

function tempPassword() {
  return `Temp${crypto.randomBytes(4).toString('hex')}!`;
}

function ownerAdminFilter(orgId) {
  return {
    organization: orgId,
    role: 'admin',
    isActive: true,
    $or: [
      { adminRole: 'owner_admin' },
      { adminRole: { $exists: false } },
      { adminRole: null },
    ],
  };
}

async function activeOwnerAdminCount(orgId) {
  return OrganizationMember.countDocuments(ownerAdminFilter(orgId));
}

function serializeMembership(membership) {
  const user = membership.user || {};
  return {
    _id: user._id,
    userId: user._id,
    membershipId: membership._id,
    name: user.name,
    email: user.email,
    role: normalizeAdminRole(membership),
    roleLabel: ADMIN_ROLE_LABELS[normalizeAdminRole(membership)] || normalizeAdminRole(membership),
    permissions: getEffectivePermissions(membership),
    isActive: membership.isActive,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt,
    disabledAt: membership.disabledAt || null,
  };
}

exports.getMyPermissions = async (req, res) => {
  const adminRole = req.membership ? normalizeAdminRole(req.membership) : (req.user.role === 'admin' ? 'owner_admin' : null);
  const permissions = req.membership ? getEffectivePermissions(req.membership) : ROLE_PERMISSIONS.owner_admin;
  res.json({
    success: true,
    data: {
      role: adminRole,
      roleLabel: ADMIN_ROLE_LABELS[adminRole] || adminRole,
      permissions,
      roles: ADMIN_ROLES.map(role => ({
        role,
        label: ADMIN_ROLE_LABELS[role],
        permissions: ROLE_PERMISSIONS[role],
      })),
    },
  });
};

exports.listAdmins = async (req, res, next) => {
  try {
    const memberships = await OrganizationMember.find({
      organization: req.orgId,
      role: 'admin',
    })
      .populate('user', 'name email isActive lastLoginAt createdAt')
      .sort({ isActive: -1, createdAt: 1 });

    res.json({
      success: true,
      data: {
        admins: memberships.filter(m => m.user).map(serializeMembership),
        roles: ADMIN_ROLES.map(role => ({
          role,
          label: ADMIN_ROLE_LABELS[role],
          permissions: ROLE_PERMISSIONS[role],
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.inviteAdmin = async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const adminRole = req.body.role || 'read_only';

    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Nombre y email son obligatorios.' });
    }
    if (!ADMIN_ROLES.includes(adminRole)) {
      return res.status(400).json({ success: false, message: 'El rol seleccionado no es válido.' });
    }

    let user = await User.findOne({ email });
    let rawPassword = null;
    let isNewUser = false;

    if (!user) {
      rawPassword = tempPassword();
      user = await User.create({
        name,
        email,
        password: rawPassword,
        role: 'admin',
        organization: req.orgId,
        mustChangePassword: true,
        temporaryPasswordCreatedAt: new Date(),
        createdBy: req.user._id,
      });
      isNewUser = true;
    } else if (!user.isActive) {
      return res.status(400).json({ success: false, message: 'Ese usuario está desactivado. Contactá al soporte.' });
    }

    const existing = await OrganizationMember.findOne({
      user: user._id,
      organization: req.orgId,
      role: 'admin',
    });
    if (existing?.isActive) {
      return res.status(409).json({ success: false, message: 'Ese usuario ya es administrador de esta organización.' });
    }

    const membership = existing || new OrganizationMember({
      user: user._id,
      organization: req.orgId,
      role: 'admin',
      createdBy: req.user._id,
    });
    membership.adminRole = adminRole;
    membership.isActive = true;
    membership.deactivatedByOrganization = false;
    membership.disabledAt = undefined;
    membership.disabledBy = undefined;
    membership.reactivatedAt = existing ? new Date() : undefined;
    membership.updatedBy = req.user._id;
    await membership.save();
    await membership.populate('user', 'name email isActive lastLoginAt createdAt');

    if (isNewUser) {
      const userData = user.toObject();
      delete userData.password;
      sendAdminWelcome(userData, rawPassword, req.org?.name || 'tu organización').catch((err) =>
        logger.error(`Error enviando bienvenida al administrador ${email}: ${err.message}`)
      );
    }

    res.status(existing ? 200 : 201).json({
      success: true,
      message: isNewUser
        ? 'Administrador invitado correctamente.'
        : 'Administrador agregado correctamente.',
      data: { admin: serializeMembership(membership) },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateAdminRole = async (req, res, next) => {
  try {
    const adminRole = req.body.role;
    if (!ADMIN_ROLES.includes(adminRole)) {
      return res.status(400).json({ success: false, message: 'El rol seleccionado no es válido.' });
    }

    const membership = await OrganizationMember.findOne({
      user: req.params.userId,
      organization: req.orgId,
      role: 'admin',
      isActive: true,
    }).populate('user', 'name email isActive lastLoginAt createdAt');
    if (!membership) {
      return res.status(404).json({ success: false, message: 'Administrador no encontrado.' });
    }

    const currentRole = normalizeAdminRole(membership);
    const isSelf = String(membership.user._id) === String(req.user._id);
    if (currentRole === 'owner_admin' && adminRole !== 'owner_admin' && isSelf && await activeOwnerAdminCount(req.orgId) <= 1) {
      return res.status(400).json({
        success: false,
        message: 'No podés quitarte el rol de administrador principal si sos el único activo.',
      });
    }
    if (currentRole === 'owner_admin' && adminRole !== 'owner_admin' && await activeOwnerAdminCount(req.orgId) <= 1) {
      return res.status(400).json({
        success: false,
        message: 'La organización debe conservar al menos un administrador principal activo.',
      });
    }

    membership.adminRole = adminRole;
    membership.updatedBy = req.user._id;
    await membership.save();

    res.json({
      success: true,
      message: 'Rol actualizado correctamente.',
      data: { admin: serializeMembership(membership) },
    });
  } catch (err) {
    next(err);
  }
};

exports.disableAdmin = async (req, res, next) => {
  try {
    const membership = await OrganizationMember.findOne({
      user: req.params.userId,
      organization: req.orgId,
      role: 'admin',
      isActive: true,
    }).populate('user', 'name email isActive lastLoginAt createdAt');
    if (!membership) {
      return res.status(404).json({ success: false, message: 'Administrador no encontrado.' });
    }

    const currentRole = normalizeAdminRole(membership);
    const isSelf = String(membership.user._id) === String(req.user._id);
    if (currentRole === 'owner_admin' && isSelf && await activeOwnerAdminCount(req.orgId) <= 1) {
      return res.status(400).json({
        success: false,
        message: 'No podés desactivar tu acceso si sos el único administrador principal activo.',
      });
    }
    if (currentRole === 'owner_admin' && await activeOwnerAdminCount(req.orgId) <= 1) {
      return res.status(400).json({
        success: false,
        message: 'La organización debe conservar al menos un administrador principal activo.',
      });
    }

    membership.isActive = false;
    membership.deactivatedByOrganization = true;
    membership.deactivatedAt = new Date();
    membership.disabledAt = new Date();
    membership.disabledBy = req.user._id;
    membership.updatedBy = req.user._id;
    await membership.save();

    res.json({
      success: true,
      message: 'Acceso administrativo desactivado.',
      data: { admin: serializeMembership(membership) },
    });
  } catch (err) {
    next(err);
  }
};
