const Provider = require('../models/Provider');
const logger   = require('../config/logger');

// ── GET /api/providers ────────────────────────────────────────
exports.getProviders = async (req, res, next) => {
  try {
    const filter = { organization: req.orgId };
    if (req.query.includeInactive !== 'true') filter.active = true;

    const providers = await Provider.find(filter).sort({ name: 1 }).select('-__v');
    res.json({ success: true, data: { providers } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/providers ───────────────────────────────────────
exports.createProvider = async (req, res, next) => {
  try {
    const allowed = ['name', 'serviceType', 'cuit', 'phone', 'email'];
    const data    = { organization: req.orgId };
    allowed.forEach((f) => { if (req.body[f] !== undefined) data[f] = req.body[f]; });

    const provider = await Provider.create(data);
    logger.info(`Proveedor creado: ${provider.name} [org: ${req.orgId}]`);
    res.status(201).json({ success: true, data: { provider } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/providers/:id ──────────────────────────────────
exports.updateProvider = async (req, res, next) => {
  try {
    const allowed = ['name', 'serviceType', 'cuit', 'phone', 'email', 'active'];
    const update  = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

    const provider = await Provider.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      update,
      { new: true, runValidators: true }
    );
    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado.' });

    res.json({ success: true, data: { provider } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/providers/:id — soft delete ───────────────────
exports.deleteProvider = async (req, res, next) => {
  try {
    const provider = await Provider.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      { active: false },
      { new: true }
    );
    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado.' });

    logger.info(`Proveedor desactivado: ${provider.name} [org: ${req.orgId}]`);
    res.json({ success: true, message: 'Proveedor desactivado correctamente.' });
  } catch (err) {
    next(err);
  }
};
