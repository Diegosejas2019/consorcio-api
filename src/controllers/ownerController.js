const User               = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Payment = require('../models/Payment');
const Unit    = require('../models/Unit');
const logger  = require('../config/logger');
const { sendToUser } = require('../services/firebaseService');
const { sendWelcome } = require('../services/emailService');
const { formatYYYYMM, getNextMonth } = require('../utils/periods');
const XLSX    = require('xlsx');

// Campos del User que son identidad global (no datos financieros por org)
const USER_FIELDS = new Set(['name', 'email', 'password', 'unit', 'unitId', 'phone', 'phones', 'role', 'organization', 'createdBy', 'isActive']);

function normalizeUnitName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function normalizeDebtBalance(raw, fallback = 0) {
  const amount = Number(raw ?? fallback);
  if (!Number.isFinite(amount)) return fallback;
  return amount > 0 ? -amount : amount;
}

function getRequestedUnitIds(body) {
  const values = [];
  if (body.unitIds !== undefined) {
    values.push(...(Array.isArray(body.unitIds) ? body.unitIds : [body.unitIds]));
  }
  if (body.unitId !== undefined && body.unitId !== null && body.unitId !== '') {
    values.push(body.unitId);
  }
  return [...new Set(values.map(id => String(id)).filter(Boolean))];
}

function normalizePhonesInput(body) {
  const values = [];

  if (body.phones !== undefined) {
    values.push(...(Array.isArray(body.phones) ? body.phones : [body.phones]));
  }
  if (body.phone !== undefined) values.push(body.phone);

  const phones = [...new Set(values
    .flatMap(value => String(value || '').split(/[,;\n]/))
    .map(value => value.trim())
    .filter(Boolean))];
  if (!phones.length && (body.phones !== undefined || body.phone !== undefined)) return { phone: undefined, phones: [] };
  if (!phones.length) return {};

  return { phone: phones[0], phones };
}

async function findAssignableUnits(unitIds, orgId, ownerId) {
  if (!unitIds.length) return { units: [] };

  const units = await Unit.find({
    _id: { $in: unitIds },
    organization: orgId,
    active: true,
  });
  const foundIds = new Set(units.map(u => u._id.toString()));
  const missing = unitIds.find(id => !foundIds.has(id));
  if (missing) return { error: { status: 404, message: 'Unidad no encontrada.' } };

  const occupied = units.find(unit => unit.owner && (!ownerId || unit.owner.toString() !== ownerId.toString()));
  if (occupied) {
    return { error: { status: 400, message: `La unidad ${occupied.name} ya estÃ¡ ocupada.` } };
  }

  return { units };
}

async function syncOwnerUnits(ownerId, orgId, requestedUnitIds) {
  const { units, error } = await findAssignableUnits(requestedUnitIds, orgId, ownerId);
  if (error) return { error };

  const requestedSet = new Set(requestedUnitIds);
  const currentUnits = await Unit.find({ owner: ownerId, organization: orgId, active: true }).select('_id');
  const releaseIds = currentUnits
    .map(u => u._id)
    .filter(id => !requestedSet.has(id.toString()));

  await Promise.all([
    releaseIds.length
      ? Unit.updateMany({ _id: { $in: releaseIds } }, { owner: null, status: 'available' })
      : Promise.resolve(),
    requestedUnitIds.length
      ? Unit.updateMany({ _id: { $in: requestedUnitIds } }, { owner: ownerId, status: 'occupied' })
      : Promise.resolve(),
    User.findByIdAndUpdate(ownerId, { unitId: requestedUnitIds[0] || null }),
  ]);

  return { units };
}

async function validateLegacyUnitAvailable(orgId, unitName, ownerId = null) {
  const normalized = normalizeUnitName(unitName);
  if (!normalized) return null;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const memberships = await OrganizationMember.find({ organization: orgId, role: 'owner', isActive: true })
    .select('user')
    .lean();
  const ownerIds = memberships.map(m => m.user).filter(id => !ownerId || id.toString() !== ownerId.toString());

  const legacyOwner = ownerIds.length
    ? await User.findOne({
        _id: { $in: ownerIds },
        role: 'owner',
        isActive: true,
        unit: { $regex: `^${escaped}$`, $options: 'i' },
      }).select('_id unit')
    : null;
  if (legacyOwner) return legacyOwner.unit || normalized;

  const existingUnit = await Unit.findOne({
    organization: orgId,
    active: true,
    name: { $regex: `^${escaped}$`, $options: 'i' },
    owner: { $ne: ownerId || null },
  }).select('name owner');
  if (existingUnit?.owner) return existingUnit.name || normalized;

  return null;
}

// ── GET /api/owners — listar todos (admin) ────────────────────
exports.getAllOwners = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isDebtor } = req.query;

    const memberFilter = { organization: req.orgId, role: 'owner', isActive: true };
    if (isDebtor !== undefined) memberFilter.isDebtor = isDebtor === 'true';

    let memberships = await OrganizationMember.find(memberFilter)
      .populate('user', 'name email unitId phone phones initials lastLogin createdAt isActive')
      .lean();

    memberships = memberships.filter(m => m.user != null);

    // Cargar todas las unidades de la org para sort + search
    const allUnits = await Unit.find({ organization: req.orgId, active: true })
      .select('owner name')
      .lean();

    const unitsByOwner = allUnits.reduce((map, u) => {
      if (u.owner) (map[u.owner.toString()] ||= []).push(u.name);
      return map;
    }, {});

    if (search) {
      const re = new RegExp(search, 'i');
      memberships = memberships.filter(m => {
        const unitNames = unitsByOwner[m.user._id.toString()] ?? [];
        return re.test(m.user.name) || re.test(m.user.email) || unitNames.some(n => re.test(n));
      });
    }

    // Ordenar por nombre de unidad
    memberships.sort((a, b) => {
      const ua = (unitsByOwner[a.user._id.toString()] ?? [])[0] ?? '';
      const ub = (unitsByOwner[b.user._id.toString()] ?? [])[0] ?? '';
      return ua.localeCompare(ub);
    });

    const total = memberships.length;
    const paged = memberships.slice((page - 1) * limit, page * limit);
    const ownerIds = paged.map(m => m.user._id);

    const lastPayments = await Payment.aggregate([
      { $match: { owner: { $in: ownerIds }, status: 'approved' } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$owner',
          month:     { $first: '$month' },
          amount:    { $first: '$amount' },
          createdAt: { $first: '$createdAt' },
        },
      },
    ]);

    const lastPaymentByOwner = lastPayments.reduce((map, p) => {
      map[p._id.toString()] = { month: p.month, amount: p.amount, createdAt: p.createdAt };
      return map;
    }, {});

    const owners = paged.map(m => ({
      ...m.user,
      balance:            normalizeDebtBalance(m.balance),
      isDebtor:           m.isDebtor,
      percentage:         m.percentage,
      startBillingPeriod: m.startBillingPeriod,
      role:               m.role,
      membershipId:       m._id,
      lastPayment:        lastPaymentByOwner[m.user._id.toString()] ?? null,
      units:              unitsByOwner[m.user._id.toString()] ?? [],
    }));

    res.json({
      success: true,
      data: { owners },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/:id — detalle de un propietario ───────────
exports.getOwner = async (req, res, next) => {
  try {
    const membership = await OrganizationMember.findOne({
      user: req.params.id,
      organization: req.orgId,
      role: 'owner',
      isActive: true,
    }).populate('user', '-__v -password -fcmToken -passwordResetToken -passwordResetExpires');

    if (!membership || !membership.user) {
      return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    }

    const owner = {
      ...membership.user.toObject(),
      balance:            normalizeDebtBalance(membership.balance),
      isDebtor:           membership.isDebtor,
      percentage:         membership.percentage,
      startBillingPeriod: membership.startBillingPeriod,
      role:               membership.role,
      membershipId:       membership._id,
    };

    const payments = await Payment.find({ owner: membership.user._id, organization: req.orgId })
      .sort({ createdAt: -1 })
      .select('-__v');

    res.json({ success: true, data: { owner, payments } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/owners — crear propietario (admin) ──────────────
exports.createOwner = async (req, res, next) => {
  try {
    const allowed  = ['name', 'email', 'password', 'unit', 'phone', 'phones', 'percentage'];
    const ownerData = { role: 'owner', organization: req.orgId, createdBy: req.user._id };
    allowed.forEach((f) => { if (req.body[f] !== undefined) ownerData[f] = req.body[f]; });
    Object.assign(ownerData, normalizePhonesInput(req.body));
    if (ownerData.unit) {
      ownerData.unit = normalizeUnitName(ownerData.unit);
      const conflict = await validateLegacyUnitAvailable(req.orgId, ownerData.unit);
      if (conflict) {
        return res.status(400).json({ success: false, message: `La unidad ${conflict} ya está asignada a otro propietario.` });
      }
    }

    const initialDebtAmount = Number(req.body.initialDebtAmount ?? 0);
    if (initialDebtAmount < 0) {
      return res.status(400).json({ success: false, message: 'La deuda inicial no puede ser negativa.' });
    }
    ownerData.balance  = normalizeDebtBalance(initialDebtAmount);
    ownerData.isDebtor = initialDebtAmount > 0;

    const currentPeriod = formatYYYYMM(new Date());
    const chargeCurrentMonth = req.body.chargeCurrentMonth !== false;
    ownerData.startBillingPeriod = chargeCurrentMonth ? currentPeriod : getNextMonth(currentPeriod);

    const tempPassword = req.body.password;
    const requestedUnitIds = getRequestedUnitIds(req.body);

    let owner;
    let sendWelcomeEmail = true;

    if (req.body.email) {
      const existingActive = await User.findOne({ email: req.body.email, isActive: true });

      if (existingActive) {
        const membershipExists = await OrganizationMember.findOne({
          user: existingActive._id,
          organization: req.orgId,
          isActive: true,
        });
        if (membershipExists) {
          return res.status(400).json({ success: false, message: 'El usuario ya pertenece a esta organización.' });
        }
        const preservedUnit = normalizeUnitName(ownerData.unit || existingActive.unit);
        if (preservedUnit) {
          const conflict = await validateLegacyUnitAvailable(req.orgId, preservedUnit, existingActive._id);
          if (conflict) {
            return res.status(400).json({ success: false, message: `La unidad ${conflict} ya está asignada a otro propietario.` });
          }
          ownerData.unit = preservedUnit;
        }
        const { password: _p, ...rawUpdate } = ownerData;
        const updateFields = Object.fromEntries(Object.entries(rawUpdate).filter(([k]) => USER_FIELDS.has(k)));
        owner = await User.findByIdAndUpdate(existingActive._id, updateFields, { new: true, runValidators: false });
        sendWelcomeEmail = false;
        logger.info(`Propietario existente vinculado: ${owner.email} [org: ${req.orgId}]`);
      } else {
        const existingInactive = await User.findOne({ email: req.body.email, isActive: false }).select('+password');
        if (existingInactive) {
          const preservedUnit = normalizeUnitName(ownerData.unit || existingInactive.unit);
          if (preservedUnit) {
            const conflict = await validateLegacyUnitAvailable(req.orgId, preservedUnit, existingInactive._id);
            if (conflict) {
              return res.status(400).json({ success: false, message: `La unidad ${conflict} ya está asignada a otro propietario.` });
            }
            ownerData.unit = preservedUnit;
          }
          const inactiveUpdate = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
          Object.assign(existingInactive, inactiveUpdate, { isActive: true });
          if (tempPassword) existingInactive.password = tempPassword;
          await existingInactive.save();
          existingInactive.password = undefined;
          owner = existingInactive;
          logger.info(`Propietario reactivado: ${owner.email} [org: ${req.orgId}]`);
        }
      }
    }

    if (!owner) {
      const { error } = await findAssignableUnits(requestedUnitIds, req.orgId, null);
      if (error) return res.status(error.status).json({ success: false, message: error.message });

      if (!req.body.password) {
        return res.status(400).json({ success: false, message: 'La contraseña es obligatoria para nuevos propietarios.' });
      }
      const userCreateData = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
      owner = await User.create(userCreateData);
      logger.info(`Propietario creado: ${owner.email} [org: ${req.orgId}]`);
      owner.password = undefined;
    }

    const { error: unitError } = await findAssignableUnits(requestedUnitIds, req.orgId, owner._id);
    if (unitError) return res.status(unitError.status).json({ success: false, message: unitError.message });

    await OrganizationMember.findOneAndUpdate(
      { user: owner._id, organization: req.orgId, role: 'owner' },
      {
        $set: {
          balance:            ownerData.balance,
          isDebtor:           ownerData.isDebtor,
          startBillingPeriod: ownerData.startBillingPeriod,
          percentage:         ownerData.percentage || 0,
          isActive:           true,
          createdBy:          req.user._id,
        },
      },
      { upsert: true }
    );

    // Asignar unidad si se proveyó unitId
    let assignedUnits = [];
    if (req.body.unitIds !== undefined || req.body.unitId !== undefined) {
      const { units, error } = await syncOwnerUnits(owner._id, req.orgId, requestedUnitIds);
      if (error) return res.status(error.status).json({ success: false, message: error.message });
      assignedUnits = units;
      owner = await User.findById(owner._id).select('-password -fcmToken');
    }

    if (sendWelcomeEmail) {
      sendWelcome(owner, tempPassword, assignedUnits.map(unit => unit.name)).catch((err) =>
        logger.error(`Error enviando email de bienvenida a ${owner.email}: ${err.message}`)
      );
    }

    res.status(201).json({ success: true, data: { owner: { ...owner.toObject(), units: assignedUnits } } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/owners/:id — actualizar datos ──────────────────
exports.updateOwner = async (req, res, next) => {
  try {
    const memberFields = ['balance', 'isDebtor', 'percentage', 'startBillingPeriod'];
    const userFields   = ['name', 'phone', 'phones', 'isActive'];

    const userUpdate   = {};
    const memberUpdate = {};
    [...memberFields, ...userFields].forEach((f) => {
      if (req.body[f] !== undefined) {
        if (f === 'balance') memberUpdate.balance = normalizeDebtBalance(req.body.balance);
        else if (memberFields.includes(f)) memberUpdate[f] = req.body[f];
        else userUpdate[f] = req.body[f];
      }
    });
    if (memberUpdate.balance !== undefined) {
      memberUpdate.isDebtor = memberUpdate.balance < 0;
    }
    Object.assign(userUpdate, normalizePhonesInput(req.body));

    const membership = await OrganizationMember.findOne({
      user: req.params.id,
      organization: req.orgId,
      isActive: true,
    });
    if (!membership) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    // Cambio de unidad
    let assignedUnits = null;
    if (req.body.unitIds !== undefined || req.body.unitId !== undefined) {
      const requestedUnitIds = getRequestedUnitIds(req.body);
      const { units, error } = await syncOwnerUnits(req.params.id, req.orgId, requestedUnitIds);
      if (error) return res.status(error.status).json({ success: false, message: error.message });
      assignedUnits = units;
    }

    await Promise.all([
      Object.keys(userUpdate).length > 0
        ? User.findByIdAndUpdate(req.params.id, userUpdate, { runValidators: true })
        : Promise.resolve(),
      Object.keys(memberUpdate).length > 0
        ? OrganizationMember.findByIdAndUpdate(membership._id, memberUpdate)
        : Promise.resolve(),
    ]);

    const [updatedUser, updatedMember] = await Promise.all([
      User.findById(req.params.id).select('-__v -password -fcmToken'),
      OrganizationMember.findById(membership._id),
    ]);

    const owner = {
      ...updatedUser.toObject(),
      balance:            normalizeDebtBalance(updatedMember.balance),
      isDebtor:           updatedMember.isDebtor,
      percentage:         updatedMember.percentage,
      startBillingPeriod: updatedMember.startBillingPeriod,
      ...(assignedUnits ? { units: assignedUnits } : {}),
    };

    res.json({ success: true, data: { owner } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/owners/:id — desactivar (soft delete) ─────────
exports.deleteOwner = async (req, res, next) => {
  try {
    const membership = await OrganizationMember.findOneAndUpdate(
      { user: req.params.id, organization: req.orgId, isActive: true },
      { isActive: false },
      { new: true }
    );
    if (!membership) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    // Liberar todas las unidades asignadas a este propietario en esta org.
    await Promise.all([
      Unit.updateMany(
        { owner: req.params.id, organization: req.orgId, active: true },
        { owner: null, status: 'available' }
      ),
      User.findByIdAndUpdate(req.params.id, { unitId: null }),
    ]);

    // Desactivar User solo si no tiene otras membresías activas
    const remaining = await OrganizationMember.countDocuments({
      user: req.params.id,
      isActive: true,
    });
    if (remaining === 0) {
      await User.findByIdAndUpdate(req.params.id, { isActive: false });
    }

    logger.info(`Propietario desactivado: userId=${req.params.id} org=${req.orgId}`);
    res.json({ success: true, message: 'Propietario desactivado correctamente.' });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/owners/:id/notify — enviar push a un propietario ─
exports.notifyOwner = async (req, res, next) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ success: false, message: 'title y body son requeridos.' });

    const membership = await OrganizationMember.findOne({
      user: req.params.id,
      organization: req.orgId,
      role: 'owner',
      isActive: true,
    }).populate('user', 'email');
    if (!membership) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    await sendToUser(req.params.id, { title, body, data: { type: 'admin_message' } });
    logger.info(`Push enviado a ${membership.user.email} por admin ${req.user.email}`);
    res.json({ success: true, message: 'Notificación enviada.' });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/bulk/template — descargar plantilla Excel ─
exports.downloadBulkTemplate = (_req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['nombre', 'email', 'contraseña', 'telefono', 'telefonos', 'saldo', 'moroso'],
    ['María García', 'maria@mail.com', 'clave123', '1122334455', '1122334455; 1199887766', '0', 'no'],
    ['Juan Pérez',   'juan@mail.com',  'clave456', '',           '',                       '0', 'no'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Propietarios');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_propietarios.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

// ── POST /api/owners/bulk — carga masiva desde Excel (admin) ──
exports.bulkCreateOwners = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Se requiere un archivo Excel (.xlsx).' });
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch {
      return res.status(400).json({ success: false, message: 'El archivo no es un Excel válido.' });
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows  = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'El archivo está vacío o no tiene filas de datos.' });
    }

    const COL_MAP = {
      nombre:       'name',
      email:        'email',
      'contraseña': 'password',
      telefono:     'phone',
      telefonos:    'phones',
      saldo:        'balance',
      moroso:       'isDebtor',
      name: 'name', password: 'password', phone: 'phone', phones: 'phones',
      balance: 'balance', isDebtor: 'isDebtor',
    };
    const created = [];
    const errors  = [];

    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const rowNum = i + 2;

      const ownerData = { role: 'owner', organization: req.orgId, createdBy: req.user._id, startBillingPeriod: formatYYYYMM(new Date()) };
      Object.entries(row).forEach(([col, val]) => {
        const field = COL_MAP[col.trim().toLowerCase()] || COL_MAP[col.trim()];
        if (field && val !== undefined && val !== '') ownerData[field] = val;
      });

      if (ownerData.balance !== undefined) ownerData.balance = normalizeDebtBalance(ownerData.balance);
      Object.assign(ownerData, normalizePhonesInput(ownerData));
      if (ownerData.isDebtor !== undefined) {
        const v = String(ownerData.isDebtor).toLowerCase();
        ownerData.isDebtor = v === 'true' || v === '1' || v === 'si' || v === 'sí';
      }
      if (ownerData.balance !== undefined) ownerData.isDebtor = ownerData.balance < 0;

      if (!ownerData.name || !ownerData.email) {
        errors.push({ row: rowNum, email: ownerData.email || '', reason: 'nombre y email son obligatorios.' });
        continue;
      }

      try {
        let owner;
        let sendEmail = true;

        const existingActive = await User.findOne({ email: ownerData.email, isActive: true });

        if (existingActive) {
          const membershipExists = await OrganizationMember.findOne({
            user: existingActive._id,
            organization: req.orgId,
            isActive: true,
          });
          if (membershipExists) {
            errors.push({ row: rowNum, email: ownerData.email, reason: 'El usuario ya pertenece a esta organización.' });
            continue;
          }
          const { password: _p, ...rawBulkUpdate } = ownerData;
          const bulkUpdateFields = Object.fromEntries(Object.entries(rawBulkUpdate).filter(([k]) => USER_FIELDS.has(k)));
          owner = await User.findByIdAndUpdate(existingActive._id, bulkUpdateFields, { new: true, runValidators: false });
          sendEmail = false;
          logger.info(`Bulk: propietario existente vinculado ${owner.email} [org: ${req.orgId}]`);
        } else {
          const existingInactive = await User.findOne({ email: ownerData.email, isActive: false }).select('+password');
          if (existingInactive) {
            const rawPassword = ownerData.password;
            const inactiveUpdate = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
            Object.assign(existingInactive, inactiveUpdate, { isActive: true });
            if (rawPassword) existingInactive.password = rawPassword;
            await existingInactive.save();
            existingInactive.password = undefined;
            owner = existingInactive;
            logger.info(`Bulk: propietario reactivado ${owner.email} [org: ${req.orgId}]`);
          } else {
            if (!ownerData.password) {
              errors.push({ row: rowNum, email: ownerData.email, reason: 'La contraseña es obligatoria para nuevos propietarios.' });
              continue;
            }
            const rawPassword = ownerData.password;
            const bulkCreateData = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
            owner = await User.create(bulkCreateData);
            logger.info(`Bulk: propietario creado ${owner.email} [org: ${req.orgId}]`);
            owner.password = undefined;

            if (sendEmail) {
              sendWelcome(owner, rawPassword, []).catch((err) =>
                logger.error(`Bulk: error enviando email a ${owner.email}: ${err.message}`)
              );
            }
          }
        }

        await OrganizationMember.findOneAndUpdate(
          { user: owner._id, organization: req.orgId, role: 'owner' },
          {
            $set: {
              balance:            ownerData.balance ?? 0,
              isDebtor:           ownerData.isDebtor ?? false,
              startBillingPeriod: ownerData.startBillingPeriod,
              percentage:         ownerData.percentage || 0,
              isActive:           true,
              createdBy:          req.user._id,
            },
          },
          { upsert: true }
        );

        created.push(owner);
      } catch (err) {
        let reason = 'Error al crear el propietario.';
        if (err.code === 11000) reason = 'El email ya está registrado en esta organización.';
        else if (err.name === 'ValidationError') reason = Object.values(err.errors).map((e) => e.message).join(' ');
        errors.push({ row: rowNum, email: ownerData.email || '', reason });
      }
    }

    res.status(201).json({
      success: true,
      data: {
        created: created.length,
        errors:  errors.length,
        owners:  created,
        failed:  errors,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/check-email — verificar si email existe (admin) ──
exports.checkEmail = async (req, res, next) => {
  try {
    const { email } = req.query;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Email inválido.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim(), isActive: true }).select('_id');

    if (!user) {
      return res.json({
        success: true,
        exists: false,
        belongsToCurrentOrganization: false,
        canAddToCurrentOrganization: true,
        message: 'El email no está registrado. Se creará un nuevo usuario.',
      });
    }

    const membership = await OrganizationMember.findOne({
      user: user._id,
      organization: req.orgId,
      isActive: true,
    });

    if (membership) {
      return res.json({
        success: true,
        exists: true,
        belongsToCurrentOrganization: true,
        canAddToCurrentOrganization: false,
        message: 'Este usuario ya pertenece a esta organización.',
      });
    }

    return res.json({
      success: true,
      exists: true,
      belongsToCurrentOrganization: false,
      canAddToCurrentOrganization: true,
      message: 'Este usuario ya existe. Se asociará a esta organización y conservará su contraseña actual.',
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/stats — estadísticas generales (admin) ────
exports.getStats = async (req, res, next) => {
  try {
    const orgFilter = { organization: req.orgId };

    const [totalOwners, debtors, payments] = await Promise.all([
      OrganizationMember.countDocuments({ organization: req.orgId, role: 'owner', isActive: true }),
      OrganizationMember.countDocuments({ organization: req.orgId, role: 'owner', isActive: true, isDebtor: true }),
      Payment.find({ ...orgFilter, status: 'approved' }).select('amount month'),
    ]);

    const totalCollected = payments.reduce((sum, p) => sum + p.amount, 0);

    const monthlyAgg = await Payment.aggregate([
      { $match: { ...orgFilter, status: 'approved' } },
      { $group: { _id: '$month', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
      { $limit: 6 },
    ]);

    res.json({
      success: true,
      data: {
        totalOwners,
        debtors,
        upToDate: totalOwners - debtors,
        complianceRate: totalOwners > 0 ? Math.round(((totalOwners - debtors) / totalOwners) * 100) : 0,
        totalCollected,
        pendingPayments: await Payment.countDocuments({ ...orgFilter, status: 'pending' }),
        monthlyStats: monthlyAgg,
      },
    });
  } catch (err) {
    next(err);
  }
};
