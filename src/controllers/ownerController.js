const User    = require('../models/User');
const Payment = require('../models/Payment');
const logger  = require('../config/logger');
const { sendToUser } = require('../services/firebaseService');
const XLSX    = require('xlsx');

// ── GET /api/owners — listar todos (admin) ────────────────────
exports.getAllOwners = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isDebtor } = req.query;

    const filter = { role: 'owner', isActive: true, organization: req.orgId };
    if (search) filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { unit: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
    if (isDebtor !== undefined) filter.isDebtor = isDebtor === 'true';

    const [owners, total] = await Promise.all([
      User.find(filter)
        .select('-__v')
        .sort({ unit: 1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      User.countDocuments(filter),
    ]);

    // Enriquecer con último pago aprobado
    const enriched = await Promise.all(
      owners.map(async (owner) => {
        const lastPayment = await Payment.findOne({ owner: owner._id, status: 'approved' })
          .sort({ createdAt: -1 })
          .select('month amount createdAt');
        return { ...owner.toJSON(), lastPayment };
      })
    );

    res.json({
      success: true,
      data: { owners: enriched },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/:id — detalle de un propietario ───────────
exports.getOwner = async (req, res, next) => {
  try {
    const owner = await User.findOne({ _id: req.params.id, role: 'owner', organization: req.orgId });
    if (!owner) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    const payments = await Payment.find({ owner: owner._id, organization: req.orgId })
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
    const allowed  = ['name', 'email', 'password', 'unit', 'phone', 'balance', 'isDebtor'];
    const ownerData = { role: 'owner', organization: req.orgId };
    allowed.forEach((f) => { if (req.body[f] !== undefined) ownerData[f] = req.body[f]; });
    const owner = await User.create(ownerData);
    logger.info(`Propietario creado: ${owner.email} — ${owner.unit} [org: ${req.orgId}]`);
    owner.password = undefined;
    res.status(201).json({ success: true, data: { owner } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/owners/:id — actualizar datos ──────────────────
exports.updateOwner = async (req, res, next) => {
  try {
    const allowed = ['name', 'unit', 'phone', 'isActive', 'isDebtor', 'balance'];
    const update  = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

    const owner = await User.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      update,
      { new: true, runValidators: true }
    );
    if (!owner) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    res.json({ success: true, data: { owner } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/owners/:id — desactivar (soft delete) ─────────
exports.deleteOwner = async (req, res, next) => {
  try {
    const owner = await User.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      { isActive: false },
      { new: true }
    );
    if (!owner) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    logger.info(`Propietario desactivado: ${owner.email}`);
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

    const owner = await User.findOne({ _id: req.params.id, organization: req.orgId, role: 'owner' });
    if (!owner) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    await sendToUser(owner._id, { title, body, data: { type: 'admin_message' } });
    logger.info(`Push enviado a ${owner.email} por admin ${req.user.email}`);
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

      const ownerData = { role: 'owner', organization: req.orgId };
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

      if (!ownerData.name || !ownerData.email || !ownerData.password) {
        errors.push({ row: rowNum, email: ownerData.email || '', reason: 'name, email y password son obligatorios.' });
        continue;
      }

      try {
        const owner = await User.create(ownerData);
        logger.info(`Bulk: propietario creado ${owner.email} — ${owner.unit} [org: ${req.orgId}]`);
        owner.password = undefined;
        created.push(owner);
      } catch (err) {
        let reason = 'Error al crear el propietario.';
        if (err.code === 11000) reason = 'El email ya está registrado.';
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
      User.countDocuments({ ...orgFilter, role: 'owner', isActive: true }),
      User.countDocuments({ ...orgFilter, role: 'owner', isActive: true, isDebtor: true }),
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
