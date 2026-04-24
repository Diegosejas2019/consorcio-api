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

    if (!ownerId) return res.status(400).json({ success: false, message: 'El propietario es obligatorio.' });
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'El nombre de la unidad es obligatorio.' });

    // Verificar que el owner pertenezca a la organización
    const owner = await User.findOne({ _id: ownerId, organization: req.orgId, role: 'owner', isActive: true });
    if (!owner) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    const unit = await Unit.create({
      organization: req.orgId,
      owner:        ownerId,
      name:         name.trim(),
      coefficient:  coefficient != null ? Number(coefficient) : 1,
      customFee:    customFee != null && customFee !== '' ? Number(customFee) : null,
    });

    const org = await Organization.findById(req.orgId).select('monthlyFee');
    const finalFee = calcUnitFee(unit, org?.monthlyFee ?? 0);

    logger.info(`Unidad creada: ${unit._id} — ${unit.name} — owner: ${owner.email}`);
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
      { active: false },
      { new: true }
    );
    if (!unit) return res.status(404).json({ success: false, message: 'Unidad no encontrada.' });

    logger.info(`Unidad desactivada: ${unit._id} — ${unit.name}`);
    res.json({ success: true, message: 'Unidad eliminada correctamente.' });
  } catch (err) {
    next(err);
  }
};
