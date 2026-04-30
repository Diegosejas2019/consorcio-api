const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const AuditLog = require('../models/AuditLog');

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
