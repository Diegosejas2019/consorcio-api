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
const USER_FIELDS = new Set(['name', 'email', 'password', 'unit', 'phone', 'role', 'organization', 'createdBy', 'isActive']);

// ── GET /api/owners — listar todos (admin) ────────────────────
exports.getAllOwners = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isDebtor } = req.query;

    const memberFilter = { organization: req.orgId, role: 'owner', isActive: true };
    if (isDebtor !== undefined) memberFilter.isDebtor = isDebtor === 'true';

    let memberships = await OrganizationMember.find(memberFilter)
      .populate('user', 'name email unit phone initials lastLogin createdAt isActive')
      .lean();

    // Filtrar por búsqueda sobre campos del User
    if (search) {
      const re = new RegExp(search, 'i');
      memberships = memberships.filter(m =>
        m.user && (re.test(m.user.name) || re.test(m.user.unit) || re.test(m.user.email))
      );
    }

    // Descartar membresías con user eliminado (populate devuelve null)
    memberships = memberships.filter(m => m.user != null);

    // Ordenar por unidad
    memberships.sort((a, b) => (a.user.unit || '').localeCompare(b.user.unit || ''));

    const total = memberships.length;
    const paged = memberships.slice((page - 1) * limit, page * limit);
    const ownerIds = paged.map(m => m.user._id);

    // Enriquecer con último pago aprobado y unidades
    const [lastPayments, allUnits] = await Promise.all([
      Payment.aggregate([
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
      ]),
      Unit.find({ organization: req.orgId, active: true }).select('owner name'),
    ]);

    const lastPaymentByOwner = lastPayments.reduce((map, p) => {
      map[p._id.toString()] = { month: p.month, amount: p.amount, createdAt: p.createdAt };
      return map;
    }, {});

    const unitsByOwner = allUnits.reduce((map, u) => {
      (map[u.owner.toString()] ||= []).push(u.name);
      return map;
    }, {});

    const owners = paged.map(m => ({
      ...m.user,
      balance:            m.balance,
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
      balance:            membership.balance,
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
    const allowed  = ['name', 'email', 'password', 'unit', 'phone', 'percentage'];
    const ownerData = { role: 'owner', organization: req.orgId, createdBy: req.user._id };
    allowed.forEach((f) => { if (req.body[f] !== undefined) ownerData[f] = req.body[f]; });

    const initialDebtAmount = Number(req.body.initialDebtAmount ?? 0);
    if (initialDebtAmount < 0) {
      return res.status(400).json({ success: false, message: 'La deuda inicial no puede ser negativa.' });
    }
    // Datos financieros van solo a OrganizationMember, no a User
    ownerData.balance  = initialDebtAmount > 0 ? -initialDebtAmount : 0;
    ownerData.isDebtor = initialDebtAmount > 0;

    const currentPeriod = formatYYYYMM(new Date());
    const chargeCurrentMonth = req.body.chargeCurrentMonth !== false;
    ownerData.startBillingPeriod = chargeCurrentMonth ? currentPeriod : getNextMonth(currentPeriod);


    const tempPassword = req.body.password;

    let owner;
    let sendWelcomeEmail = true;

    if (req.body.email) {
      const existingActive = await User.findOne({ email: req.body.email, isActive: true });

      if (existingActive) {
        // Si ya tiene membresía activa en esta org, rechazar
        const membershipExists = await OrganizationMember.findOne({
          user: existingActive._id,
          organization: req.orgId,
          isActive: true,
        });
        if (membershipExists) {
          return res.status(400).json({ success: false, message: 'El usuario ya pertenece a esta organización.' });
        }
        // Actualizar campos del User sin tocar la contraseña ni datos financieros por org
        const { password: _p, ...rawUpdate } = ownerData;
        const updateFields = Object.fromEntries(Object.entries(rawUpdate).filter(([k]) => USER_FIELDS.has(k)));
        owner = await User.findByIdAndUpdate(existingActive._id, updateFields, { new: true, runValidators: false });
        sendWelcomeEmail = false;
        logger.info(`Propietario existente vinculado: ${owner.email} [org: ${req.orgId}]`);
      } else {
        // Usuario inactivo: reactivar
        const existingInactive = await User.findOne({ email: req.body.email, isActive: false }).select('+password');
        if (existingInactive) {
          const inactiveUpdate = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
          Object.assign(existingInactive, inactiveUpdate, { isActive: true });
          if (tempPassword) existingInactive.password = tempPassword;
          await existingInactive.save();
          existingInactive.password = undefined;
          owner = existingInactive;
          logger.info(`Propietario reactivado: ${owner.email} — ${owner.unit} [org: ${req.orgId}]`);
        }
      }
    }

    if (!owner) {
      if (!req.body.password) {
        return res.status(400).json({ success: false, message: 'La contraseña es obligatoria para nuevos propietarios.' });
      }
      const userCreateData = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
      owner = await User.create(userCreateData);
      logger.info(`Propietario creado: ${owner.email} — ${owner.unit} [org: ${req.orgId}]`);
      owner.password = undefined;
    }

    // Crear o actualizar OrganizationMember (upsert para idempotencia)
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

    if (sendWelcomeEmail) {
      const unitNames = owner.unit ? [owner.unit] : [];
      sendWelcome(owner, tempPassword, unitNames).catch((err) =>
        logger.error(`Error enviando email de bienvenida a ${owner.email}: ${err.message}`)
      );
    }

    res.status(201).json({ success: true, data: { owner } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/owners/:id — actualizar datos ──────────────────
exports.updateOwner = async (req, res, next) => {
  try {
    const memberFields = ['balance', 'isDebtor', 'percentage', 'startBillingPeriod'];
    const userFields   = ['name', 'unit', 'phone', 'isActive'];

    const userUpdate   = {};
    const memberUpdate = {};
    [...memberFields, ...userFields].forEach((f) => {
      if (req.body[f] !== undefined) {
        if (memberFields.includes(f)) memberUpdate[f] = req.body[f];
        else userUpdate[f] = req.body[f];
      }
    });

    // Verificar membresía en esta org
    const membership = await OrganizationMember.findOne({
      user: req.params.id,
      organization: req.orgId,
      isActive: true,
    });
    if (!membership) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

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
      balance:            updatedMember.balance,
      isDebtor:           updatedMember.isDebtor,
      percentage:         updatedMember.percentage,
      startBillingPeriod: updatedMember.startBillingPeriod,
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
    ['nombre', 'email', 'contraseña', 'unidad', 'telefono', 'saldo', 'moroso'],
    ['María García', 'maria@mail.com', 'clave123', 'Lote 12', '1122334455', '0', 'no'],
    ['Juan Pérez',   'juan@mail.com',  'clave456', 'Casa 5A', '',           '0', 'no'],
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

    // Mapeo columnas español → campo del modelo
    const COL_MAP = {
      nombre:     'name',
      email:      'email',
      'contraseña': 'password',
      unidad:     'unit',
      telefono:   'phone',
      saldo:      'balance',
      moroso:     'isDebtor',
      // también aceptar inglés por compatibilidad
      name: 'name', password: 'password', unit: 'unit', phone: 'phone',
      balance: 'balance', isDebtor: 'isDebtor',
    };
    const created = [];
    const errors  = [];

    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const rowNum = i + 2; // fila Excel (1 = encabezados)

      const ownerData = { role: 'owner', organization: req.orgId, createdBy: req.user._id, startBillingPeriod: formatYYYYMM(new Date()) };
      Object.entries(row).forEach(([col, val]) => {
        const field = COL_MAP[col.trim().toLowerCase()] || COL_MAP[col.trim()];
        if (field && val !== undefined && val !== '') ownerData[field] = val;
      });

      // Convertir tipos
      if (ownerData.balance !== undefined) ownerData.balance = Number(ownerData.balance);
      if (ownerData.isDebtor !== undefined) {
        const v = String(ownerData.isDebtor).toLowerCase();
        ownerData.isDebtor = v === 'true' || v === '1' || v === 'si' || v === 'sí';
      }

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
            logger.info(`Bulk: propietario creado ${owner.email} — ${owner.unit} [org: ${req.orgId}]`);
            owner.password = undefined;

            const unitNames = owner.unit ? [owner.unit] : [];
            if (sendEmail) {
              sendWelcome(owner, rawPassword, unitNames).catch((err) =>
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
