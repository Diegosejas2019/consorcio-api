const crypto             = require('crypto');
const User               = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const ImpersonationSession = require('../models/ImpersonationSession');
const { signImpersonationToken } = require('../middleware/auth');
const { isSuperAdminRole, normalizeRole } = require('../utils/roles');
const { normalizeAdminRole } = require('../utils/adminPermissions');
const { trackUsageEvent } = require('../services/platformUsageService');
const logger = require('../config/logger');

// ── GET /api/super-admin/impersonation/users?email= ──────────
exports.searchUsers = async (req, res, next) => {
  try {
    const { email = '' } = req.query;
    if (!email || email.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Ingresá al menos 2 caracteres para buscar.' });
    }

    const regex = new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({
      $or: [{ email: regex }, { name: regex }],
      isActive: true,
    })
      .select('_id name email role isActive')
      .limit(10)
      .lean();

    // Excluir superAdmins
    const filtered = users.filter(u => !isSuperAdminRole(normalizeRole(u.role)));

    const results = await Promise.all(
      filtered.map(async (u) => {
        const memberships = await OrganizationMember.find({ user: u._id, isActive: true })
          .populate('organization', 'name')
          .select('organization role adminRole _id')
          .lean();
        return {
          userId:    u._id,
          name:      u.name,
          email:     u.email,
          isActive:  u.isActive,
          organizations: memberships.map(m => ({
            membershipId:     m._id,
            organizationId:   m.organization?._id,
            organizationName: m.organization?.name || '-',
            role:             m.role,
            adminRole:        m.adminRole || null,
          })),
        };
      })
    );

    res.json({ success: true, data: { users: results } });
  } catch (err) { next(err); }
};

// ── POST /api/super-admin/impersonation/start ────────────────
exports.startSession = async (req, res, next) => {
  try {
    const { userId, organizationId, reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'El motivo de soporte es obligatorio.' });
    }
    if (!userId || !organizationId) {
      return res.status(400).json({ success: false, message: 'userId y organizationId son requeridos.' });
    }

    const targetUser = await User.findById(userId).select('_id name email role isActive');
    if (!targetUser || !targetUser.isActive) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado o inactivo.' });
    }

    // Bloquear impersonación de superAdmin
    if (isSuperAdminRole(normalizeRole(targetUser.role))) {
      trackUsageEvent({
        userId: req.user._id,
        role: 'super_admin',
        eventType: 'impersonation.blocked',
        module: 'impersonation',
        metadata: { reason: 'target_is_superadmin', targetUserId: userId },
      });
      return res.status(403).json({ success: false, message: 'No es posible iniciar modo soporte para un superAdmin.' });
    }

    // Verificar membresía activa en la org indicada
    const membership = await OrganizationMember.findOne({
      user: userId,
      organization: organizationId,
      isActive: true,
    }).populate('organization', 'name isActive');

    if (!membership) {
      return res.status(400).json({ success: false, message: 'El usuario no tiene acceso activo a esa organización.' });
    }
    if (membership.organization?.isActive === false) {
      return res.status(400).json({ success: false, message: 'La organización se encuentra desactivada.' });
    }

    const sessionId = crypto.randomUUID();
    const token = signImpersonationToken(req.user, targetUser, membership, sessionId, reason.trim());
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await ImpersonationSession.create({
      actorUser:         req.user._id,
      actorEmail:        req.user.email,
      impersonatedUser:  targetUser._id,
      impersonatedEmail: targetUser.email,
      organization:      organizationId,
      role:              membership.role,
      adminRole:         normalizeAdminRole(membership) || null,
      reason:            reason.trim(),
      sessionId,
      ip:        req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    trackUsageEvent({
      organizationId,
      userId: req.user._id,
      role: 'super_admin',
      eventType: 'impersonation.started',
      module: 'impersonation',
      metadata: {
        sessionId,
        impersonatedUserId: userId,
        impersonatedEmail: targetUser.email,
        impersonatedRole: membership.role,
      },
    });

    logger.info(`[Impersonation] Iniciado por ${req.user.email} → ${targetUser.email} (org=${organizationId}) sessionId=${sessionId}`);

    res.json({
      success: true,
      data: {
        token,
        sessionId,
        expiresAt,
        impersonatedUser: {
          name:      targetUser.name,
          email:     targetUser.email,
          role:      membership.role,
          adminRole: normalizeAdminRole(membership) || null,
          accessType: membership.role === 'admin' ? 'admin' : 'owner',
        },
      },
    });
  } catch (err) { next(err); }
};

// ── POST /api/super-admin/impersonation/stop ─────────────────
exports.stopSession = async (req, res, next) => {
  try {
    if (!req.impersonation?.active) {
      return res.status(400).json({ success: false, message: 'No hay sesión de modo soporte activa.' });
    }

    const { sessionId } = req.impersonation;
    await ImpersonationSession.findOneAndUpdate(
      { sessionId },
      { endedAt: new Date(), status: 'ended' }
    );

    trackUsageEvent({
      userId: req.impersonation.actorId,
      role: 'super_admin',
      eventType: 'impersonation.stopped',
      module: 'impersonation',
      metadata: { sessionId, impersonatedUserId: req.user._id },
    });

    logger.info(`[Impersonation] Finalizado sessionId=${sessionId} usuario=${req.user.email}`);
    res.json({ success: true, message: 'Sesión de modo soporte finalizada.' });
  } catch (err) { next(err); }
};

// ── GET /api/super-admin/impersonation/sessions ──────────────
exports.listSessions = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, actorId, impersonatedEmail } = req.query;
    const filter = {};
    if (actorId) filter.actorUser = actorId;
    if (impersonatedEmail) {
      filter.impersonatedEmail = new RegExp(impersonatedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const [sessions, total] = await Promise.all([
      ImpersonationSession.find(filter)
        .select('-ip -userAgent')
        .populate('organization', 'name')
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      ImpersonationSession.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { sessions },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};
