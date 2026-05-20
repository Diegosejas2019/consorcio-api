const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const PlatformUsageEvent = require('../models/PlatformUsageEvent');
const logger = require('../config/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function parseDateParam(value, endOfDay = false) {
  if (!value || !DATE_RE.test(String(value))) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + (endOfDay ? 1 : 0)));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getDateRange(req) {
  const now = new Date();
  const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const defaultFrom = new Date(defaultTo.getTime() - (30 * DAY_MS));

  const from = req.query.from ? parseDateParam(req.query.from) : defaultFrom;
  const to = req.query.to ? parseDateParam(req.query.to, true) : defaultTo;

  if (!from || !to || from >= to) {
    return { error: 'El rango de fechas no es válido.' };
  }

  return { from, to };
}

function eventCountExpr(eventType) {
  return { $sum: { $cond: [{ $eq: ['$eventType', eventType] }, 1, 0] } };
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

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

exports.getAnalyticsOverview = async (req, res, next) => {
  try {
    const now = new Date();
    const todayStart = startOfUtcDay(now);
    const monthStart = startOfUtcMonth(now);
    const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);

    const [
      activeUsersToday,
      activeUsersThisMonth,
      totalOrganizations,
      activeOrganizationsThisMonth,
      monthlyCounts,
    ] = await Promise.all([
      PlatformUsageEvent.distinct('userId', {
        createdAt: { $gte: todayStart, $lt: tomorrowStart },
        userId: { $ne: null },
      }),
      PlatformUsageEvent.distinct('userId', {
        createdAt: { $gte: monthStart },
        userId: { $ne: null },
      }),
      Organization.countDocuments(),
      PlatformUsageEvent.distinct('organizationId', {
        createdAt: { $gte: monthStart },
        organizationId: { $ne: null },
      }),
      PlatformUsageEvent.aggregate([
        { $match: { createdAt: { $gte: monthStart } } },
        {
          $group: {
            _id: null,
            documentsUploadedThisMonth: eventCountExpr('documents.upload'),
            paymentsCreatedThisMonth: eventCountExpr('payments.created'),
            claimsCreatedThisMonth: eventCountExpr('claims.created'),
            noticesCreatedThisMonth: eventCountExpr('notices.created'),
          },
        },
      ]),
    ]);

    const counts = monthlyCounts[0] || {};

    res.json({
      success: true,
      data: {
        activeUsersToday: activeUsersToday.length,
        activeUsersThisMonth: activeUsersThisMonth.length,
        totalOrganizations,
        activeOrganizationsThisMonth: activeOrganizationsThisMonth.length,
        documentsUploadedThisMonth: counts.documentsUploadedThisMonth || 0,
        paymentsCreatedThisMonth: counts.paymentsCreatedThisMonth || 0,
        claimsCreatedThisMonth: counts.claimsCreatedThisMonth || 0,
        noticesCreatedThisMonth: counts.noticesCreatedThisMonth || 0,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.getDailyActivity = async (req, res, next) => {
  try {
    const range = getDateRange(req);
    if (range.error) return res.status(400).json({ success: false, message: range.error });

    const rows = await PlatformUsageEvent.aggregate([
      { $match: { createdAt: { $gte: range.from, $lt: range.to } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          totalEvents: { $sum: 1 },
          users: { $addToSet: '$userId' },
          logins: eventCountExpr('auth.login'),
          uploads: eventCountExpr('documents.upload'),
          payments: eventCountExpr('payments.created'),
          claims: eventCountExpr('claims.created'),
          notices: eventCountExpr('notices.created'),
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const byDate = new Map(rows.map(row => [row._id, row]));
    const data = [];
    for (let cursor = new Date(range.from); cursor < range.to; cursor = new Date(cursor.getTime() + DAY_MS)) {
      const date = formatDateKey(cursor);
      const row = byDate.get(date);
      data.push({
        date,
        totalEvents: row?.totalEvents || 0,
        activeUsers: row?.users?.filter(Boolean).length || 0,
        logins: row?.logins || 0,
        uploads: row?.uploads || 0,
        payments: row?.payments || 0,
        claims: row?.claims || 0,
        notices: row?.notices || 0,
      });
    }

    res.json({ success: true, data: { activity: data } });
  } catch (err) {
    next(err);
  }
};

exports.getOrganizationAnalytics = async (req, res, next) => {
  try {
    const range = getDateRange(req);
    if (range.error) return res.status(400).json({ success: false, message: range.error });

    const organizations = await PlatformUsageEvent.aggregate([
      {
        $match: {
          createdAt: { $gte: range.from, $lt: range.to },
          organizationId: { $ne: null },
        },
      },
      {
        $group: {
          _id: '$organizationId',
          activeUsersSet: { $addToSet: '$userId' },
          totalEvents: { $sum: 1 },
          logins: eventCountExpr('auth.login'),
          documentsUploaded: eventCountExpr('documents.upload'),
          paymentsCreated: eventCountExpr('payments.created'),
          claimsCreated: eventCountExpr('claims.created'),
          noticesCreated: eventCountExpr('notices.created'),
          lastActivityAt: { $max: '$createdAt' },
        },
      },
      {
        $lookup: {
          from: 'organizations',
          localField: '_id',
          foreignField: '_id',
          as: 'organization',
        },
      },
      { $unwind: { path: '$organization', preserveNullAndEmptyArrays: true } },
      { $sort: { lastActivityAt: -1 } },
      {
        $project: {
          _id: 0,
          organizationId: '$_id',
          organizationName: { $ifNull: ['$organization.name', 'Organización sin nombre'] },
          activeUsers: {
            $size: {
              $filter: { input: '$activeUsersSet', as: 'userId', cond: { $ne: ['$$userId', null] } },
            },
          },
          totalEvents: 1,
          logins: 1,
          documentsUploaded: 1,
          paymentsCreated: 1,
          claimsCreated: 1,
          noticesCreated: 1,
          lastActivityAt: 1,
        },
      },
    ]);

    res.json({ success: true, data: { organizations } });
  } catch (err) {
    next(err);
  }
};

exports.getModuleAnalytics = async (req, res, next) => {
  try {
    const range = getDateRange(req);
    if (range.error) return res.status(400).json({ success: false, message: range.error });

    const modules = await PlatformUsageEvent.aggregate([
      { $match: { createdAt: { $gte: range.from, $lt: range.to } } },
      { $group: { _id: '$module', totalEvents: { $sum: 1 } } },
      { $sort: { totalEvents: -1 } },
      { $project: { _id: 0, module: '$_id', totalEvents: 1 } },
    ]);

    res.json({ success: true, data: { modules } });
  } catch (err) {
    next(err);
  }
};
