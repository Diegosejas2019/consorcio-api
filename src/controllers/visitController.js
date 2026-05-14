const Visit  = require('../models/Visit');
const logger = require('../config/logger');

// ── GET /api/visits ───────────────────────────────────────────
exports.getVisits = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, status, date, owner: ownerFilter } = req.query;

    const filter = { organization: req.orgId };

    if (req.accessType === 'owner') {
      filter.owner = req.ownerId;
    } else if (ownerFilter) {
      filter.owner = ownerFilter;
    }

    if (status) filter.status = status;

    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      filter.expectedDate = { $gte: start, $lte: end };
    }

    const [visits, total] = await Promise.all([
      Visit.find(filter)
        .populate('owner', 'name unit email')
        .sort({ expectedDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-__v'),
      Visit.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { visits },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/visits — crear visita (owner) ───────────────────
exports.createVisit = async (req, res, next) => {
  try {
    const { name, type, expectedDate, note } = req.body;

    const visit = await Visit.create({
      organization: req.orgId,
      owner:        req.ownerId,
      name,
      type,
      expectedDate,
      note,
      status:       'approved',
      approvedBy:   req.user._id,
      approvedAt:   new Date(),
    });

    await visit.populate('owner', 'name unit email');

    logger.info(`Visita creada: "${visit.name}" por ${req.user.name}`);
    res.status(201).json({ success: true, data: { visit } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/visits/:id/status — cambiar estado (admin) ─────
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['approved', 'rejected', 'inside', 'exited'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Estado no válido.' });
    }

    const visit = await Visit.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name unit email');
    if (!visit) return res.status(404).json({ success: false, message: 'Visita no encontrada.' });

    visit.status = status;
    if (status === 'approved' && !visit.approvedBy) {
      visit.approvedBy = req.user._id;
      visit.approvedAt = new Date();
    }
    await visit.save();

    logger.info(`Visita ${visit._id} → ${status} por ${req.user.name}`);
    res.json({ success: true, data: { visit } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/visits/:id ────────────────────────────────────
exports.deleteVisit = async (req, res, next) => {
  try {
    const visit = await Visit.findOne({ _id: req.params.id, organization: req.orgId });
    if (!visit) return res.status(404).json({ success: false, message: 'Visita no encontrada.' });

    if (req.accessType === 'owner') {
      if (visit.owner.toString() !== req.ownerId?.toString()) {
        return res.status(403).json({ success: false, message: 'Acceso denegado.' });
      }
      if (visit.status !== 'pending') {
        return res.status(400).json({ success: false, message: 'Solo podés eliminar visitas pendientes.' });
      }
    }

    await visit.deleteOne();
    res.json({ success: true, message: 'Visita eliminada.' });
  } catch (err) {
    next(err);
  }
};
