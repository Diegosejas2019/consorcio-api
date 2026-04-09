const User    = require('../models/User');
const Payment = require('../models/Payment');
const logger  = require('../config/logger');

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
    const { name, email, password, unit, phone } = req.body;
    const owner = await User.create({
      name, email, password, unit, phone,
      role: 'owner',
      organization: req.orgId,
    });
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
