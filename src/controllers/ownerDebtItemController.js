const OwnerDebtItem      = require('../models/OwnerDebtItem');
const OrganizationMember = require('../models/OrganizationMember');

// ── POST /api/owners/:id/debt-items ──────────────────────────
exports.createDebtItem = async (req, res, next) => {
  try {
    const ownerId = req.params.id;

    // Verificar que el propietario pertenece a la misma organización
    const membership = await OrganizationMember.findOne({
      user: ownerId,
      organization: req.orgId,
      isActive: { $ne: false },
    });
    if (!membership) {
      return res.status(404).json({ success: false, message: 'Propietario no encontrado en esta organización.' });
    }

    const { type, description, amount, currency, originDate, dueDate } = req.body;

    if (!type || !['previous_balance', 'manual_adjustment'].includes(type)) {
      return res.status(400).json({ success: false, message: 'El tipo es obligatorio y debe ser "previous_balance" o "manual_adjustment".' });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, message: 'La descripción es obligatoria.' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'El importe debe ser mayor a cero.' });
    }
    if (!currency || !['ARS', 'USD'].includes(currency)) {
      return res.status(400).json({ success: false, message: 'La moneda debe ser ARS o USD.' });
    }

    const debtItem = await OwnerDebtItem.create({
      organization: req.orgId,
      owner:        ownerId,
      type,
      description:  String(description).trim(),
      amount:       Number(amount),
      currency,
      originDate:   originDate || undefined,
      dueDate:      dueDate    || undefined,
      createdBy:    req.user._id,
    });

    res.status(201).json({ success: true, data: { debtItem } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/:id/debt-items ────────────────────────────
exports.getDebtItemsByOwner = async (req, res, next) => {
  try {
    const ownerId = req.params.id;

    // Verificar que el propietario pertenece a la organización
    const membership = await OrganizationMember.findOne({
      user: ownerId,
      organization: req.orgId,
      isActive: { $ne: false },
    });
    if (!membership) {
      return res.status(404).json({ success: false, message: 'Propietario no encontrado en esta organización.' });
    }

    const debtItems = await OwnerDebtItem.find({
      organization: req.orgId,
      owner:        ownerId,
      isActive:     { $ne: false },
    }).sort({ createdAt: -1 });

    res.json({ success: true, data: { debtItems } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/debt-items/:id/cancel ─────────────────────────
exports.cancelDebtItem = async (req, res, next) => {
  try {
    const debtItem = await OwnerDebtItem.findOne({
      _id:          req.params.id,
      organization: req.orgId,
      isActive:     { $ne: false },
    });
    if (!debtItem) {
      return res.status(404).json({ success: false, message: 'Deuda no encontrada.' });
    }
    if (debtItem.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Solo se pueden anular deudas con estado pendiente.' });
    }

    const { cancellationReason } = req.body;
    if (!cancellationReason || !String(cancellationReason).trim()) {
      return res.status(400).json({ success: false, message: 'El motivo de anulación es obligatorio.' });
    }

    debtItem.status             = 'cancelled';
    debtItem.cancelledBy        = req.user._id;
    debtItem.cancelledAt        = new Date();
    debtItem.cancellationReason = String(cancellationReason).trim();
    await debtItem.save();

    res.json({ success: true, data: { debtItem } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/debt-items/mine ──────────────────────────────────
exports.getMyDebtItems = async (req, res, next) => {
  try {
    const debtItems = await OwnerDebtItem.find({
      organization: req.orgId,
      owner:        req.user._id,
      isActive:     { $ne: false },
      status:       { $nin: ['cancelled'] },
    }).sort({ createdAt: -1 });

    res.json({ success: true, data: { debtItems } });
  } catch (err) {
    next(err);
  }
};
