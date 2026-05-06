const Unit         = require('../models/Unit');
const User         = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const logger       = require('../config/logger');

// ── Helper: calcular monto final de una unidad ────────────────
function calcUnitFee(unit, monthlyFee) {
  return unit.customFee != null ? unit.customFee : (monthlyFee * unit.coefficient);
}
exports.calcUnitFee = calcUnitFee;

function getEffectiveUnitStatus(unit) {
  if (unit.active === false) return 'inactive';
  if (unit.owner) return 'occupied';
  if (unit.status === 'inactive') return 'inactive';
  return 'available';
}

async function findActiveOwnerInOrg(ownerId, orgId) {
  if (!ownerId) return null;

  const membership = await OrganizationMember.findOne({
    user: ownerId,
    organization: orgId,
    role: 'owner',
    isActive: true,
  }).populate('user', 'name email role isActive unitId');

  if (membership?.user?.isActive !== false) return membership.user;

  // Backward compatibility para usuarios legacy sin OrganizationMember.
  return User.findOne({ _id: ownerId, organization: orgId, role: 'owner', isActive: true });
}

async function assignFallbackUnitId(ownerId, orgId, exceptUnitId = null) {
  if (!ownerId) return;
  const nextUnit = await Unit.findOne({
    owner: ownerId,
    organization: orgId,
    active: true,
    ...(exceptUnitId ? { _id: { $ne: exceptUnitId } } : {}),
  }).sort({ name: 1 }).select('_id');

  await User.findByIdAndUpdate(ownerId, { unitId: nextUnit?._id || null });
}

function extractUnitNumber(name) {
  const match = String(name ?? '').trim().match(/(\d+)\s*$/);
  if (!match) return null;
  return String(Number(match[1]));
}

async function ensureUnitNameAvailable(orgId, name, excludeId = null) {
  const unitNumber = extractUnitNumber(name);
  const existing = await Unit.find({
    organization: orgId,
    active: true,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).select('_id name').lean();

  return !existing.some(unit => {
    const existingName = String(unit.name).trim();
    if (existingName.toLowerCase() === name.trim().toLowerCase()) return true;
    return unitNumber && extractUnitNumber(existingName) === unitNumber;
  });
}

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

    const enriched = units.map(u => {
      const unit = u.toJSON();
      return {
        ...unit,
        status: getEffectiveUnitStatus(unit),
        finalFee: calcUnitFee(u, monthlyFee),
      };
    });

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
    const unitName = name.trim();
    if (!(await ensureUnitNameAvailable(req.orgId, unitName))) {
      return res.status(400).json({ success: false, message: `La unidad "${unitName}" ya existe.` });
    }

    let owner = null;
    if (ownerId) {
      owner = await findActiveOwnerInOrg(ownerId, req.orgId);
      if (!owner) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    }

    const unit = await Unit.create({
      organization: req.orgId,
      owner:        ownerId || null,
      status:       ownerId ? 'occupied' : 'available',
      name:         unitName,
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

// ── POST /api/units/bulk — crear unidades por rango (admin) ───
exports.bulkCreateUnits = async (req, res, next) => {
  try {
    const count = Number(req.body.count);
    const start = Number(req.body.start ?? 1);
    const prefix = String(req.body.prefix ?? 'Lote ').trimEnd();
    const separator = prefix ? ' ' : '';

    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      return res.status(400).json({ success: false, message: 'La cantidad debe ser un número entero entre 1 y 1000.' });
    }
    if (!Number.isInteger(start) || start < 0) {
      return res.status(400).json({ success: false, message: 'El número inicial debe ser un entero mayor o igual a 0.' });
    }

    const names = Array.from({ length: count }, (_, i) => `${prefix}${separator}${start + i}`.trim());
    const existing = await Unit.find({ organization: req.orgId, active: true })
      .select('name')
      .lean();
    const existingNames = new Set(existing.map(u => String(u.name).trim().toLowerCase()));
    const existingNumbers = new Set(
      existing.map(u => extractUnitNumber(u.name)).filter(Boolean)
    );

    const docs = [];
    const skipped = [];
    for (const name of names) {
      const normalizedName = name.toLowerCase();
      const unitNumber = extractUnitNumber(name);
      if (existingNames.has(normalizedName) || (unitNumber && existingNumbers.has(unitNumber))) {
        skipped.push(name);
        continue;
      }
      existingNames.add(normalizedName);
      if (unitNumber) existingNumbers.add(unitNumber);
      docs.push({
        organization: req.orgId,
        owner: null,
        status: 'available',
        name,
        coefficient: 1,
        customFee: null,
        active: true,
      });
    }

    const created = docs.length ? await Unit.insertMany(docs, { ordered: false }) : [];

    logger.info(`Unidades creadas por rango: ${created.length}/${count} org=${req.orgId}`);
    res.status(201).json({
      success: true,
      data: {
        created: created.length,
        skipped: skipped.length,
        skippedNames: skipped,
        units: created,
      },
    });
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
    if (update.name && !(await ensureUnitNameAvailable(req.orgId, update.name, req.params.id))) {
      return res.status(400).json({ success: false, message: `La unidad "${update.name}" ya existe.` });
    }

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
      await assignFallbackUnitId(unit.owner, req.orgId, unit._id);
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
      findActiveOwnerInOrg(ownerId, req.orgId),
    ]);

    if (!unit)  return res.status(404).json({ success: false, message: 'Unidad no encontrada.' });
    if (!owner) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    if (unit.owner && unit.owner.toString() !== ownerId.toString()) {
      return res.status(400).json({ success: false, message: 'La unidad ya está ocupada.' });
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
      Unit.findByIdAndUpdate(unit._id, { owner: null, status: 'available' }),
    ]);
    await assignFallbackUnitId(unit.owner, req.orgId, unit._id);

    logger.info(`Unidad ${unit.name} liberada`);
    res.json({ success: true, message: 'Propietario liberado correctamente.' });
  } catch (err) {
    next(err);
  }
};
