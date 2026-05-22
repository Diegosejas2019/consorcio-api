const crypto = require('crypto');
const User = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Organization = require('../models/Organization');
const Unit = require('../models/Unit');
const OrganizationAccessRequest = require('../models/OrganizationAccessRequest');
const { sendWelcome, sendAccessRequestNotification, sendAccessRequestRejected } = require('./emailService');
const { formatYYYYMM, getNextMonth } = require('../utils/periods');
const { normalizeDebtBalance } = require('../utils/ownerFinance');
const logger = require('../config/logger');

// Campos del User que son seguros para actualizar en usuarios existentes
const EXISTING_USER_FIELDS = new Set(['name', 'unit', 'unitId', 'phone', 'phones', 'isActive']);
const USER_FIELDS = new Set(['name', 'email', 'password', 'unit', 'unitId', 'phone', 'phones', 'role', 'organization', 'createdBy', 'isActive']);

function generateJoinCode() {
  return crypto.randomBytes(6).toString('hex');
}

async function resolveOrgByJoinCode(joinCode) {
  if (!joinCode) {
    const err = new Error('Código de invitación inválido.');
    err.statusCode = 404;
    throw err;
  }
  const org = await Organization.findOne({ publicJoinCode: joinCode }).select(
    'name businessType memberLabel unitLabel isActive publicJoinEnabled publicJoinCode adminEmail'
  );
  if (!org || !org.isActive) {
    const err = new Error('El enlace de registro no es válido o ha expirado.');
    err.statusCode = 404;
    throw err;
  }
  if (!org.publicJoinEnabled) {
    const err = new Error('Esta organización no está aceptando solicitudes públicas en este momento.');
    err.statusCode = 404;
    throw err;
  }
  return org;
}

async function createAccessRequest({ orgId, name, email, phone, requestedUnitLabel, message, joinCode, requestIp }) {
  // Verificar solicitud pending duplicada (mismo email + org)
  const existing = await OrganizationAccessRequest.findOne({
    organization: orgId,
    email: email.toLowerCase().trim(),
    status: 'pending',
  });
  if (existing) {
    const err = new Error('Ya tenés una solicitud pendiente para esta organización.');
    err.statusCode = 400;
    throw err;
  }

  // Verificar si el email corresponde a un usuario existente en GestionAr
  let userId = null;
  let isExistingUser = false;
  const existingUser = await User.findOne({ email: email.toLowerCase().trim(), isActive: true }).select('_id email');
  if (existingUser) {
    userId = existingUser._id;
    isExistingUser = true;
    // Si ya es miembro activo en esta org, guardamos igualmente la solicitud pero marcamos
    // Nota: no revelamos esta info al solicitante — respuesta siempre genérica
  }

  const requestData = {
    organization: orgId,
    joinCode,
    name: name.trim(),
    email: email.toLowerCase().trim(),
    phone: phone ? phone.trim() : undefined,
    requestedUnitLabel: requestedUnitLabel ? requestedUnitLabel.trim() : undefined,
    message: message ? message.trim() : undefined,
    userId,
    isExistingUser,
    requestIp,
  };

  const request = await OrganizationAccessRequest.create(requestData);

  // Notificar al admin de la org (catch silencioso)
  const org = await Organization.findById(orgId).select('name adminEmail');
  if (org?.adminEmail) {
    sendAccessRequestNotification(org.adminEmail, org.name, name, requestedUnitLabel).catch((err) =>
      logger.error(`Error enviando notificación de solicitud a admin: ${err.message}`)
    );
  }

  return request;
}

async function createAccessRequestAuthenticated({ userId, orgId, joinCode, requestedUnitLabel, message }) {
  const user = await User.findById(userId).select('name email phone phones isActive');
  if (!user || !user.isActive) {
    const err = new Error('Usuario no encontrado.');
    err.statusCode = 404;
    throw err;
  }

  // Verificar que no sea ya miembro activo en esta org
  const existingMembership = await OrganizationMember.findOne({
    user: userId,
    organization: orgId,
    role: 'owner',
    isActive: true,
  });
  if (existingMembership) {
    const err = new Error('Ya sos miembro activo de esta organización.');
    err.statusCode = 400;
    throw err;
  }

  // Verificar solicitud pending duplicada
  const existing = await OrganizationAccessRequest.findOne({
    organization: orgId,
    email: user.email,
    status: 'pending',
  });
  if (existing) {
    const err = new Error('Ya tenés una solicitud pendiente para esta organización.');
    err.statusCode = 400;
    throw err;
  }

  const request = await OrganizationAccessRequest.create({
    organization: orgId,
    joinCode,
    name: user.name,
    email: user.email,
    phone: user.phone,
    requestedUnitLabel: requestedUnitLabel ? requestedUnitLabel.trim() : undefined,
    message: message ? message.trim() : undefined,
    userId,
    isExistingUser: true,
  });

  // Notificar al admin (catch silencioso)
  const org = await Organization.findById(orgId).select('name adminEmail');
  if (org?.adminEmail) {
    sendAccessRequestNotification(org.adminEmail, org.name, user.name, requestedUnitLabel).catch((err) =>
      logger.error(`Error enviando notificación de solicitud a admin: ${err.message}`)
    );
  }

  return request;
}

async function getAccessRequestsForAdmin({ orgId, status, page = 1, limit = 20 }) {
  const filter = { organization: orgId };
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [requests, total] = await Promise.all([
    OrganizationAccessRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('reviewedBy', 'name email')
      .populate('createdUserId', 'name email')
      .lean(),
    OrganizationAccessRequest.countDocuments(filter),
  ]);

  return { requests, total, pages: Math.ceil(total / limit) };
}

async function getAccessRequestById({ requestId, orgId }) {
  const request = await OrganizationAccessRequest.findOne({
    _id: requestId,
    organization: orgId,
  })
    .populate('reviewedBy', 'name email')
    .populate('createdUserId', 'name email')
    .lean();

  if (!request) {
    const err = new Error('Solicitud no encontrada.');
    err.statusCode = 404;
    throw err;
  }
  return request;
}

async function approveAccessRequest({ requestId, orgId, adminUserId, unitIds = [], chargeCurrentMonth = true }) {
  const request = await OrganizationAccessRequest.findOne({ _id: requestId, organization: orgId });
  if (!request) {
    const err = new Error('Solicitud no encontrada.');
    err.statusCode = 404;
    throw err;
  }
  if (request.status !== 'pending') {
    const err = new Error(`La solicitud ya fue ${request.status === 'approved' ? 'aprobada' : 'rechazada'}.`);
    err.statusCode = 400;
    throw err;
  }

  const currentPeriod = formatYYYYMM(new Date());
  const startBillingPeriod = chargeCurrentMonth ? currentPeriod : getNextMonth(currentPeriod);

  // Generar contraseña temporal para usuarios nuevos
  const tempPassword = crypto.randomBytes(8).toString('hex');

  let owner;
  let sendWelcomeEmail = true;

  // ── Caso 1: usuario existente activo ─────────────────────────
  if (request.userId) {
    const existingActive = await User.findOne({ _id: request.userId, isActive: true });
    if (existingActive) {
      // Verificar que no sea ya miembro (puede haber cambiado entre la solicitud y la aprobación)
      const alreadyMember = await OrganizationMember.findOne({
        user: existingActive._id,
        organization: orgId,
        role: 'owner',
        isActive: true,
      });
      if (alreadyMember) {
        const err = new Error('El usuario ya es miembro activo de esta organización.');
        err.statusCode = 400;
        throw err;
      }
      owner = existingActive;
      sendWelcomeEmail = false; // No pisa contraseña ni envía email — el user ya tiene acceso
    }
  }

  // ── Caso 2: email existe pero no tenemos userId (o el userId cambió) ─
  if (!owner) {
    const existingByEmail = await User.findOne({ email: request.email, isActive: true });
    if (existingByEmail) {
      const alreadyMember = await OrganizationMember.findOne({
        user: existingByEmail._id,
        organization: orgId,
        role: 'owner',
        isActive: true,
      });
      if (alreadyMember) {
        const err = new Error('El usuario ya es miembro activo de esta organización.');
        err.statusCode = 400;
        throw err;
      }
      // Actualizar solo campos seguros (NUNCA contraseña)
      const safeUpdate = { name: request.name };
      if (request.phone) safeUpdate.phone = request.phone;
      owner = await User.findByIdAndUpdate(existingByEmail._id, safeUpdate, { new: true, runValidators: false });
      sendWelcomeEmail = false;
      logger.info(`Solicitud aprobada: propietario existente vinculado: ${owner.email} [org: ${orgId}]`);
    }
  }

  // ── Caso 3: usuario inactivo ──────────────────────────────────
  if (!owner) {
    const existingInactive = await User.findOne({ email: request.email, isActive: false }).select('+password');
    if (existingInactive) {
      existingInactive.isActive = true;
      existingInactive.name = request.name;
      if (request.phone) existingInactive.phone = request.phone;
      existingInactive.password = tempPassword;
      existingInactive.mustChangePassword = true;
      existingInactive.temporaryPasswordCreatedAt = new Date();
      await existingInactive.save();
      existingInactive.password = undefined;
      owner = existingInactive;
      logger.info(`Solicitud aprobada: propietario reactivado: ${owner.email} [org: ${orgId}]`);
    }
  }

  // ── Caso 4: usuario completamente nuevo ───────────────────────
  if (!owner) {
    owner = await User.create({
      name: request.name,
      email: request.email,
      phone: request.phone,
      password: tempPassword,
      role: 'owner',
      organization: orgId,
      createdBy: adminUserId,
      mustChangePassword: true,
      temporaryPasswordCreatedAt: new Date(),
      isActive: true,
    });
    owner.password = undefined;
    logger.info(`Solicitud aprobada: nuevo propietario creado: ${owner.email} [org: ${orgId}]`);
  }

  // ── Crear/actualizar OrganizationMember ───────────────────────
  await OrganizationMember.findOneAndUpdate(
    { user: owner._id, organization: orgId, role: 'owner' },
    {
      $set: {
        balance: 0,
        isDebtor: false,
        startBillingPeriod,
        percentage: 0,
        isActive: true,
        createdBy: adminUserId,
      },
    },
    { upsert: true }
  );

  // ── Asignar unidades si se proveyeron ─────────────────────────
  let assignedUnits = [];
  if (unitIds.length) {
    const units = await Unit.find({
      _id: { $in: unitIds },
      organization: orgId,
      active: true,
    });

    const occupied = units.find(
      (u) => u.owner && u.owner.toString() !== owner._id.toString()
    );
    if (occupied) {
      // Limpiar el user y membership creados si hay error
      const err = new Error(`La unidad "${occupied.name}" ya está ocupada por otro propietario.`);
      err.statusCode = 400;
      throw err;
    }

    await Unit.updateMany(
      { _id: { $in: unitIds } },
      { owner: owner._id, status: 'occupied', startBillingPeriod }
    );
    await User.findByIdAndUpdate(owner._id, { unitId: unitIds[0] });
    assignedUnits = units;
  }

  // ── Enviar email de bienvenida ────────────────────────────────
  if (sendWelcomeEmail) {
    sendWelcome(owner, tempPassword, assignedUnits.map((u) => u.name)).catch((err) =>
      logger.error(`Error enviando email de bienvenida (solicitud aprobada) a ${owner.email}: ${err.message}`)
    );
  }

  // ── Actualizar solicitud ──────────────────────────────────────
  request.status = 'approved';
  request.reviewedBy = adminUserId;
  request.reviewedAt = new Date();
  request.createdUserId = owner._id;
  await request.save();

  return { owner, request };
}

async function rejectAccessRequest({ requestId, orgId, adminUserId, rejectionReason }) {
  const request = await OrganizationAccessRequest.findOne({ _id: requestId, organization: orgId });
  if (!request) {
    const err = new Error('Solicitud no encontrada.');
    err.statusCode = 404;
    throw err;
  }
  if (request.status !== 'pending') {
    const err = new Error(`La solicitud ya fue ${request.status === 'approved' ? 'aprobada' : 'rechazada'}.`);
    err.statusCode = 400;
    throw err;
  }

  request.status = 'rejected';
  request.reviewedBy = adminUserId;
  request.reviewedAt = new Date();
  if (rejectionReason) request.rejectionReason = rejectionReason.trim();
  await request.save();

  // Notificar al solicitante (catch silencioso)
  const org = await Organization.findById(orgId).select('name');
  sendAccessRequestRejected(request.email, request.name, org?.name || '', rejectionReason).catch((err) =>
    logger.error(`Error enviando email de rechazo a ${request.email}: ${err.message}`)
  );

  return request;
}

async function regenerateJoinCode(orgId) {
  const joinCode = generateJoinCode();
  await Organization.findByIdAndUpdate(orgId, { publicJoinCode: joinCode });
  return { joinCode };
}

async function updateJoinSettings(orgId, { publicJoinEnabled }) {
  const update = {};
  if (publicJoinEnabled !== undefined) update.publicJoinEnabled = Boolean(publicJoinEnabled);
  // Generar código si se habilita y no hay uno
  if (publicJoinEnabled === true) {
    const org = await Organization.findById(orgId).select('publicJoinCode');
    if (!org.publicJoinCode) {
      update.publicJoinCode = generateJoinCode();
    }
  }
  const org = await Organization.findByIdAndUpdate(orgId, update, { new: true }).select(
    'publicJoinCode publicJoinEnabled name'
  );
  return org;
}

module.exports = {
  generateJoinCode,
  resolveOrgByJoinCode,
  createAccessRequest,
  createAccessRequestAuthenticated,
  getAccessRequestsForAdmin,
  getAccessRequestById,
  approveAccessRequest,
  rejectAccessRequest,
  regenerateJoinCode,
  updateJoinSettings,
};
