const Visit    = require('../models/Visit');
const VisitLog = require('../models/VisitLog');
const logger   = require('../config/logger');

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

// ── GET /api/visits/today ─────────────────────────────────────
exports.getTodayVisits = async (req, res, next) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const visits = await Visit.find({
      organization: req.orgId,
      expectedDate: { $gte: start, $lte: end },
    })
      .populate('owner', 'name unit email')
      .sort({ expectedDate: 1 })
      .limit(200)
      .select('-__v');

    res.json({ success: true, data: { visits } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/visits — crear visita (owner) ───────────────────
exports.createVisit = async (req, res, next) => {
  try {
    const { name, type, expectedDate, note, guardNote } = req.body;

    const visit = await Visit.create({
      organization: req.orgId,
      owner:        req.ownerId,
      name,
      type,
      expectedDate,
      note,
      guardNote,
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
    const { status, guardNote } = req.body;
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
    if (guardNote !== undefined) visit.guardNote = guardNote;
    await visit.save();

    logger.info(`Visita ${visit._id} → ${status} por ${req.user.name}`);
    res.json({ success: true, data: { visit } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/visits/:id/check-in ─────────────────────────────
exports.checkIn = async (req, res, next) => {
  try {
    const visit = await Visit.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name unit email');
    if (!visit) return res.status(404).json({ success: false, message: 'Visita no encontrada.' });

    if (visit.status !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'La visita debe estar aprobada para registrar el ingreso.',
      });
    }

    const existing = await VisitLog.findOne({ visit: visit._id, action: 'check_in' });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Esta visita ya tiene un ingreso registrado.',
      });
    }

    visit.status = 'inside';
    await visit.save();

    const log = await VisitLog.create({
      organization:    req.orgId,
      visit:           visit._id,
      action:          'check_in',
      performedBy:     req.user._id,
      performedByName: req.user.name,
      performedByRole: req.adminRole || req.accessType,
      comment:         req.body.comment || undefined,
      visitorName:     visit.name,
      ownerId:         visit.owner?._id,
      ownerName:       visit.owner?.name,
      unitLabel:       visit.owner?.unit,
    });

    logger.info(`Check-in visita ${visit._id} ("${visit.name}") por ${req.user.name}`);
    res.json({ success: true, data: { visit, log }, message: 'Ingreso registrado correctamente.' });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/visits/:id/check-out ────────────────────────────
exports.checkOut = async (req, res, next) => {
  try {
    const visit = await Visit.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name unit email');
    if (!visit) return res.status(404).json({ success: false, message: 'Visita no encontrada.' });

    if (visit.status !== 'inside') {
      return res.status(400).json({
        success: false,
        message: 'No se puede registrar el egreso porque la visita aún no ingresó.',
      });
    }

    visit.status = 'exited';
    await visit.save();

    const log = await VisitLog.create({
      organization:    req.orgId,
      visit:           visit._id,
      action:          'check_out',
      performedBy:     req.user._id,
      performedByName: req.user.name,
      performedByRole: req.adminRole || req.accessType,
      comment:         req.body.comment || undefined,
      visitorName:     visit.name,
      ownerId:         visit.owner?._id,
      ownerName:       visit.owner?.name,
      unitLabel:       visit.owner?.unit,
    });

    logger.info(`Check-out visita ${visit._id} ("${visit.name}") por ${req.user.name}`);
    res.json({ success: true, data: { visit, log }, message: 'Egreso registrado correctamente.' });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/visits/history ───────────────────────────────────
exports.getVisitHistory = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, dateFrom, dateTo, action, visitorName } = req.query;

    const filter = { organization: req.orgId };

    if (action && ['check_in', 'check_out'].includes(action)) filter.action = action;

    if (visitorName) {
      filter.visitorName = { $regex: visitorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    if (dateFrom || dateTo) {
      filter.timestamp = {};
      if (dateFrom) {
        const from = new Date(dateFrom);
        from.setHours(0, 0, 0, 0);
        filter.timestamp.$gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        filter.timestamp.$lte = to;
      }
    }

    const [logs, total] = await Promise.all([
      VisitLog.find(filter)
        .populate('performedBy', 'name')
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      VisitLog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { logs },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/visits/:id/logs ──────────────────────────────────
exports.getVisitLogs = async (req, res, next) => {
  try {
    const visit = await Visit.findOne({ _id: req.params.id, organization: req.orgId });
    if (!visit) return res.status(404).json({ success: false, message: 'Visita no encontrada.' });

    const logs = await VisitLog.find({ visit: visit._id, organization: req.orgId })
      .populate('performedBy', 'name')
      .sort({ timestamp: 1 });

    res.json({ success: true, data: { logs } });
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
