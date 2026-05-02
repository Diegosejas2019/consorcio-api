const Unit         = require('../models/Unit');
const User         = require('../models/User');
const Organization = require('../models/Organization');
const logger       = require('../config/logger');

// ── Helper: calcular monto final de una unidad ────────────────
function calcUnitFee(unit, monthlyFee) {
  return unit.customFee != null ? unit.customFee : (monthlyFee * unit.coefficient);
}
exports.calcUnitFee = calcUnitFee;

// ── GET /api/units — listar unidades ──────────────────────────
// Admin: puede filtrar por ?ownerId=. Owner: solo las suyas.
exports.getUnits = async (req, res, next) => {
  try {
    const filter = { organization: req.orgId, active: true };

    if (req.user.role === 'owner') {
      filter.owner = req.user._id;
    } else if (req.query.ownerId) {
      filter.owner = req.query.ownerId;
    }

    const units = await Unit.find(filter)
      .populate('owner', 'name unit email')
      .sort({ name: 1 })
      .select('-__v');

    // Enriquecer con finalFee calculado usando monthlyFee de la org
    const org = await Organization.findById(req.orgId).select('monthlyFee');
    const monthlyFee = org?.monthlyFee ?? 0;

    const enriched = units.map(u => ({
      ...u.toJSON(),
      finalFee: calcUnitFee(u, monthlyFee),
    }));

    res.json({ success: true, data: { units: enriched } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/units — crear unidad (admin) ────────────────────
exports.createUnit = async (req, res, next) => {
  try {
    const { ownerId, name, coefficient, customFee } = req.body;

    if (!name?.trim()) return res.status(400).json({ success: false, message: 'El nombre de la unidad es obligatorio.' });

    let owner = null;
    if (ownerId) {
      owner = await User.findOne({ _id: ownerId, organization: req.orgId, role: 'owner', isActive: true });
      if (!owner) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    }

    const unit = await Unit.create({
      organization: req.orgId,
      owner:        ownerId || null,
      status:       ownerId ? 'occupied' : 'available',
      name:         name.trim(),
      coefficient:  coefficient != null ? Number(coefficient) : 1,
      customFee:    customFee != null && customFee !== '' ? Number(customFee) : null,
    });

    if (owner) {
      await User.findByIdAndUpdate(owner._id, { unitId: unit._id });
    }

    const org = await Organization.findById(req.orgId).select('monthlyFee');
    const finalFee = calcUnitFee(unit, org?.monthlyFee ?? 0);

    logger.info(`Unidad creada: ${unit._id} — ${unit.name}${owner ? ` — owner: ${owner.email}` : ' (sin propietario)'}`);
    res.status(201).json({ success: true, data: { unit: { ...unit.toJSON(), finalFee } } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/units/:id — actualizar unidad (admin) ──────────
exports.updateUnit = async (req, res, next) => {
  try {
    const allowed = ['name', 'coefficient', 'customFee', 'active'];
    const update  = {};
    allowed.forEach(f => {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    });
    // Normalizar: nombre trim, customFee null si vacío
    if (update.name)      update.name      = update.name.trim();
    if (update.customFee === '' || update.customFee === null) update.customFee = null;

    const unit = await Unit.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      update,
      { new: true, runValidators: true }
    );
    if (!unit) return res.status(404).json({ success: false, message: 'Unidad no encontrada.' });

    const org = await Organization.findById(req.orgId).select('monthlyFee');
    const finalFee = calcUnitFee(unit, org?.monthlyFee ?? 0);

    logger.info(`Unidad actualizada: ${unit._id} — ${unit.name}`);
    res.json({ success: true, data: { unit: { ...unit.toJSON(), finalFee } } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/units/:id — soft delete (admin) ───────────────
exports.deleteUnit = async (req, res, next) => {
  try {
    const unit = await Unit.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      { active: false, status: 'inactive' },
      { new: true }
    );
    if (!unit) return res.status(404).json({ success: false, message: 'Unidad no encontrada.' });

    // Liberar al propietario si tenía asignada esta unidad
    if (unit.owner) {
      await User.findByIdAndUpdate(unit.owner, { unitId: null });
    }

    logger.info(`Unidad desactivada: ${unit._id} — ${unit.name}`);
    res.json({ success: true, message: 'Unidad eliminada correctamente.' });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/units/:id/assign-owner — asignar propietario ──
exports.assignOwner = async (req, res, next) => {
  try {
    const { ownerId } = req.body;
    if (!ownerId) return res.status(400).json({ success: false, message: 'ownerId es obligatorio.' });

    const [unit, owner] = await Promise.all([
      Unit.findOne({ _id: req.params.id, organization: req.orgId, active: true }),
      User.findOne({ _id: ownerId, organization: req.orgId, role: 'owner', isActive: true }),
    ]);

    if (!unit)  return res.status(404).json({ success: false, message: 'Unidad no encontrada.' });
    if (!owner) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    if (unit.status === 'occupied') {
      return res.status(400).json({ success: false, message: 'La unidad ya está ocupada.' });
    }

    // Liberar unidad anterior del owner si tenía una
    if (owner.unitId) {
      await Unit.findByIdAndUpdate(owner.unitId, { owner: null, status: 'available' });
    }

    await Promise.all([
      Unit.findByIdAndUpdate(unit._id, { owner: ownerId, status: 'occupied' }),
      User.findByIdAndUpdate(ownerId, { unitId: unit._id }),
    ]);

    logger.info(`Unidad ${unit.name} asignada a ${owner.email}`);
    res.json({ success: true, message: 'Propietario asignado correctamente.' });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/units/:id/release-owner — liberar propietario ──
exports.releaseOwner = async (req, res, next) => {
  try {
    const unit = await Unit.findOne({ _id: req.params.id, organization: req.orgId, active: true });
    if (!unit) return res.status(404).json({ success: false, message: 'Unidad no encontrada.' });
    if (!unit.owner) return res.status(400).json({ success: false, message: 'La unidad no tiene propietario asignado.' });

    await Promise.all([
      User.findByIdAndUpdate(unit.owner, { unitId: null }),
      Unit.findByIdAndUpdate(unit._id, { owner: null, status: 'available' }),
    ]);

    logger.info(`Unidad ${unit.name} liberada`);
    res.json({ success: true, message: 'Propietario liberado correctamente.' });
  } catch (err) {
    next(err);
  }
};
