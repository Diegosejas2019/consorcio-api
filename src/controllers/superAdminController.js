const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const logger = require('../config/logger');

exports.updateUserPasswordByEmail = async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const newPassword = String(req.body.newPassword || '');

    if (!email) {
      return res.status(400).json({ success: false, message: 'El email es obligatorio.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'La contrasena debe tener al menos 6 caracteres.',
      });
    }

    const matches = await User.find({ email })
      .select('+password +passwordResetToken +passwordResetExpires')
      .limit(2);

    if (!matches.length) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    if (matches.length > 1) {
      return res.status(409).json({
        success: false,
        message: 'Hay mas de un usuario con ese email. No se cambio la contrasena.',
      });
    }

    const [user] = matches;

    user.password = newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    logger.info(`[SuperAdmin] Password actualizada para ${user.email} por ${req.user.email}`);

    return res.json({
      success: true,
      message: 'Contrasena actualizada correctamente.',
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          isActive: user.isActive,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateOrganizationStatus = async (req, res, next) => {
  try {
    const { isActive, reason } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'El campo isActive debe ser booleano.',
      });
    }

    const org = await Organization.findById(req.params.id);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organizacion no encontrada.' });
    }

    const now = new Date();

    if (isActive) {
      org.isActive = true;
      org.reactivatedAt = now;
      org.reactivatedBy = req.user._id;
      org.deactivatedAt = undefined;
      org.deactivatedBy = undefined;
      org.deactivationReason = undefined;
      await org.save();

      await OrganizationMember.updateMany(
        { organization: org._id, deactivatedByOrganization: true },
        {
          $set: { isActive: true, deactivatedByOrganization: false, reactivatedAt: now },
          $unset: { deactivatedAt: '' },
        }
      );

      await AuditLog.create({
        organization: org._id,
        action: 'organization_reactivated',
        performedBy: req.user._id,
        reason,
      });

      return res.json({
        success: true,
        message: 'Organizacion reactivada correctamente.',
        data: { organization: org },
      });
    }

    org.isActive = false;
    org.deactivatedAt = now;
    org.deactivatedBy = req.user._id;
    org.deactivationReason = reason || '';
    await org.save();

    await OrganizationMember.updateMany(
      { organization: org._id, isActive: true },
      {
        $set: { isActive: false, deactivatedByOrganization: true, deactivatedAt: now },
        $unset: { reactivatedAt: '' },
      }
    );

    await AuditLog.create({
      organization: org._id,
      action: 'organization_deactivated',
      performedBy: req.user._id,
      reason,
    });

    return res.json({
      success: true,
      message: 'Organizacion desactivada correctamente.',
      data: { organization: org },
    });
  } catch (err) {
    next(err);
  }
};
