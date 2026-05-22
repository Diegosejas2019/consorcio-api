const {
  resolveOrgByJoinCode,
  createAccessRequest,
  createAccessRequestAuthenticated,
  getAccessRequestsForAdmin,
  getAccessRequestById,
  approveAccessRequest,
  rejectAccessRequest,
  regenerateJoinCode,
  updateJoinSettings,
} = require('../services/accessRequestService');

// ── GET /api/join/:code — info pública de la organización ─────
exports.getOrgByJoinCode = async (req, res, next) => {
  try {
    const org = await resolveOrgByJoinCode(req.params.code);
    res.json({
      success: true,
      data: {
        organizationName: org.name,
        businessType: org.businessType,
        memberLabel: org.memberLabel || 'Propietario',
        unitLabel: org.unitLabel || 'Unidad',
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/join/:code — solicitud pública (sin auth) ───────
exports.submitPublicRequest = async (req, res, next) => {
  try {
    const { name, email, phone, requestedUnitLabel, message } = req.body;

    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'El nombre y el email son obligatorios.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'El email no es válido.' });
    }

    const org = await resolveOrgByJoinCode(req.params.code);
    const requestIp = req.ip || req.connection?.remoteAddress;

    try {
      await createAccessRequest({
        orgId: org._id,
        name,
        email,
        phone,
        requestedUnitLabel,
        message,
        joinCode: req.params.code,
        requestIp,
      });
    } catch (serviceErr) {
      // Solo re-lanzar errores de solicitud duplicada (el solicitante ya lo sabe)
      if (serviceErr.statusCode === 400) {
        return res.status(400).json({ success: false, message: serviceErr.message });
      }
      // Cualquier otro error interno: responder con mensaje genérico (no revelar info)
      return res.status(201).json({
        success: true,
        message: 'Tu solicitud fue enviada. El administrador la revisará y te contactará por email.',
      });
    }

    res.status(201).json({
      success: true,
      message: 'Tu solicitud fue enviada. El administrador la revisará y te contactará por email.',
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/join/:code/auth — solicitud autenticada ─────────
exports.submitAuthenticatedRequest = async (req, res, next) => {
  try {
    const { requestedUnitLabel, message } = req.body;
    const org = await resolveOrgByJoinCode(req.params.code);

    const request = await createAccessRequestAuthenticated({
      userId: req.user._id,
      orgId: org._id,
      joinCode: req.params.code,
      requestedUnitLabel,
      message,
    });

    res.status(201).json({
      success: true,
      message: 'Tu solicitud fue enviada. El administrador la revisará.',
      data: { requestId: request._id, status: request.status },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/access-requests — listar solicitudes (admin) ─────
exports.listAdminRequests = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const result = await getAccessRequestsForAdmin({
      orgId: req.orgId,
      status,
      page: Number(page),
      limit: Number(limit),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/access-requests/:id — detalle (admin) ───────────
exports.getAdminRequestDetail = async (req, res, next) => {
  try {
    const request = await getAccessRequestById({ requestId: req.params.id, orgId: req.orgId });
    res.json({ success: true, data: { request } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/access-requests/:id/approve — aprobar ──────────
exports.approveRequest = async (req, res, next) => {
  try {
    const { unitIds = [], chargeCurrentMonth = true } = req.body;
    const { owner, request } = await approveAccessRequest({
      requestId: req.params.id,
      orgId: req.orgId,
      adminUserId: req.user._id,
      unitIds: Array.isArray(unitIds) ? unitIds : [unitIds].filter(Boolean),
      chargeCurrentMonth: chargeCurrentMonth !== false,
    });
    res.json({
      success: true,
      message: 'Solicitud aprobada. El propietario recibirá un email con sus datos de acceso.',
      data: { owner: { _id: owner._id, name: owner.name, email: owner.email }, request },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/access-requests/:id/reject — rechazar ──────────
exports.rejectRequest = async (req, res, next) => {
  try {
    const { rejectionReason } = req.body;
    const request = await rejectAccessRequest({
      requestId: req.params.id,
      orgId: req.orgId,
      adminUserId: req.user._id,
      rejectionReason,
    });
    res.json({ success: true, message: 'Solicitud rechazada.', data: { request } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/access-requests/settings — configuración actual ─
exports.getJoinSettingsHandler = async (req, res, next) => {
  try {
    const org = await require('../models/Organization').findById(req.orgId).select(
      'publicJoinCode publicJoinEnabled name'
    );
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organización no encontrada.' });
    }
    res.json({
      success: true,
      data: {
        publicJoinEnabled: org.publicJoinEnabled,
        publicJoinCode: org.publicJoinCode || null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/access-requests/settings — configuración ──────
exports.updateJoinSettingsHandler = async (req, res, next) => {
  try {
    const { publicJoinEnabled } = req.body;
    const org = await updateJoinSettings(req.orgId, { publicJoinEnabled });
    res.json({
      success: true,
      data: {
        publicJoinEnabled: org.publicJoinEnabled,
        publicJoinCode: org.publicJoinCode || null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/access-requests/regenerate-code — nuevo código ─
exports.regenerateCodeHandler = async (req, res, next) => {
  try {
    const { joinCode } = await regenerateJoinCode(req.orgId);
    res.json({
      success: true,
      message: 'Código regenerado. Los enlaces anteriores ya no son válidos.',
      data: { joinCode },
    });
  } catch (err) {
    next(err);
  }
};
