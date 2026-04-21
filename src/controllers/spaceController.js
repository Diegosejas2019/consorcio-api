const Space       = require('../models/Space');
const Reservation = require('../models/Reservation');
const logger      = require('../config/logger');

// ── GET /api/spaces ───────────────────────────────────────────
exports.getSpaces = async (req, res, next) => {
  try {
    const spaces = await Space.find({ organization: req.orgId })
      .sort({ name: 1 })
      .select('-__v');

    res.json({ success: true, data: { spaces } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/spaces ──────────────────────────────────────────
exports.createSpace = async (req, res, next) => {
  try {
    const { name, description, capacity, requiresApproval } = req.body;

    const space = await Space.create({
      organization: req.orgId,
      name,
      description,
      capacity,
      requiresApproval: requiresApproval ?? false,
    });

    logger.info(`Espacio creado: "${space.name}" por ${req.user.name}`);
    res.status(201).json({ success: true, data: { space } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/spaces/:id ─────────────────────────────────────
exports.updateSpace = async (req, res, next) => {
  try {
    const space = await Space.findOne({ _id: req.params.id, organization: req.orgId });
    if (!space) return res.status(404).json({ success: false, message: 'Espacio no encontrado.' });

    const { name, description, capacity, requiresApproval } = req.body;
    if (name              !== undefined) space.name              = name;
    if (description       !== undefined) space.description       = description;
    if (capacity          !== undefined) space.capacity          = capacity;
    if (requiresApproval  !== undefined) space.requiresApproval  = requiresApproval;

    await space.save();

    logger.info(`Espacio actualizado: "${space.name}" por ${req.user.name}`);
    res.json({ success: true, data: { space } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/spaces/:id ────────────────────────────────────
exports.deleteSpace = async (req, res, next) => {
  try {
    const space = await Space.findOne({ _id: req.params.id, organization: req.orgId });
    if (!space) return res.status(404).json({ success: false, message: 'Espacio no encontrado.' });

    // Verificar que no tenga reservas activas
    const activeCount = await Reservation.countDocuments({
      space:  req.params.id,
      status: { $in: ['pending', 'approved'] },
    });
    if (activeCount > 0) {
      return res.status(400).json({
        success: false,
        message: `No se puede eliminar el espacio porque tiene ${activeCount} reserva(s) activa(s).`,
      });
    }

    await space.deleteOne();
    logger.info(`Espacio eliminado: "${space.name}" por ${req.user.name}`);
    res.json({ success: true, message: 'Espacio eliminado.' });
  } catch (err) {
    next(err);
  }
};
