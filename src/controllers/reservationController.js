const Reservation     = require('../models/Reservation');
const Space           = require('../models/Space');
const firebaseService = require('../services/firebaseService');
const User            = require('../models/User');
const logger          = require('../config/logger');

// ── Utilidad: detectar solapamiento de horarios ───────────────
// Devuelve true si [s1, e1) se superpone con [s2, e2)
// Funciona con strings HH:mm (comparación lexicográfica en 24h)
function isTimeOverlap(start1, end1, start2, end2) {
  return start1 < end2 && end1 > start2;
}

// ── GET /api/reservations ─────────────────────────────────────
exports.getReservations = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, date, spaceId, status } = req.query;

    const filter = { organization: req.orgId };
    if (req.accessType === 'owner') filter.owner = req.ownerId;
    if (date)    filter.date  = date;
    if (spaceId) filter.space = spaceId;
    if (status)  filter.status = status;

    const [reservations, total] = await Promise.all([
      Reservation.find(filter)
        .populate('owner', 'name unit email')
        .populate('space', 'name requiresApproval')
        .sort({ date: -1, startTime: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-__v'),
      Reservation.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { reservations },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/reservations ────────────────────────────────────
exports.createReservation = async (req, res, next) => {
  try {
    const { spaceId, date, startTime, endTime, note } = req.body;

    // 1. Validar campos requeridos
    if (!spaceId)    return res.status(400).json({ success: false, message: 'El espacio es obligatorio.' });
    if (!date)       return res.status(400).json({ success: false, message: 'La fecha es obligatoria.' });
    if (!startTime)  return res.status(400).json({ success: false, message: 'La hora de inicio es obligatoria.' });
    if (!endTime)    return res.status(400).json({ success: false, message: 'La hora de fin es obligatoria.' });

    // 2. Validar que endTime > startTime
    if (endTime <= startTime) {
      return res.status(400).json({
        success: false,
        message: 'La hora de fin debe ser posterior a la hora de inicio.',
      });
    }

    // 3. Validar que la fecha no sea pasada
    const today = new Date().toISOString().slice(0, 10);
    if (date < today) {
      return res.status(400).json({
        success: false,
        message: 'No se permiten reservas en el pasado.',
      });
    }

    // 4. Verificar que el espacio existe y pertenece a la organización
    const space = await Space.findOne({ _id: spaceId, organization: req.orgId });
    if (!space) return res.status(404).json({ success: false, message: 'Espacio no encontrado.' });

    // 5. Verificar solapamiento con reservas existentes (pending o approved)
    const existingReservations = await Reservation.find({
      space:  spaceId,
      date,
      status: { $in: ['pending', 'approved'] },
    }).select('startTime endTime');

    const conflict = existingReservations.find(r =>
      isTimeOverlap(startTime, endTime, r.startTime, r.endTime)
    );

    if (conflict) {
      return res.status(409).json({
        success: false,
        message: `El horario seleccionado ya está reservado (${conflict.startTime}–${conflict.endTime}). Elegí otro horario.`,
      });
    }

    // 6. Determinar estado inicial según configuración del espacio
    const initialStatus = space.requiresApproval ? 'pending' : 'approved';

    const reservation = await Reservation.create({
      organization: req.orgId,
      owner:        req.ownerId,
      space:        spaceId,
      date,
      startTime,
      endTime,
      status: initialStatus,
      note,
    });

    await reservation.populate([
      { path: 'owner', select: 'name unit email' },
      { path: 'space', select: 'name requiresApproval' },
    ]);

    // Notificar al admin si requiere aprobación
    if (space.requiresApproval) {
      const admins = await User.find({ organization: req.orgId, role: 'admin', isActive: true })
        .select('+fcmToken');
      const tokens = admins.filter(a => a.fcmToken).map(a => a.fcmToken);
      if (tokens.length > 0) {
        firebaseService.sendMulticast(tokens, {
          title: '📅 Nueva reserva pendiente',
          body:  `${reservation.owner.name} reservó ${space.name} para el ${date} (${startTime}–${endTime})`,
          data:  { type: 'new_reservation', reservationId: reservation._id.toString() },
        }).catch(err => logger.warn(`Push admin reserva falló: ${err.message}`));
      }
    }

    logger.info(`Reserva creada: ${space.name} el ${date} (${startTime}–${endTime}) por ${req.user.name}`);
    res.status(201).json({ success: true, data: { reservation } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/reservations/:id/status ───────────────────────
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['approved', 'rejected', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Estado inválido.' });
    }

    const reservation = await Reservation.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name unit email')
      .populate('space', 'name');
    if (!reservation) return res.status(404).json({ success: false, message: 'Reserva no encontrada.' });

    reservation.status = status;
    await reservation.save();

    // Notificar al owner del resultado
    const statusMessages = {
      approved:  `Tu reserva de ${reservation.space?.name} para el ${reservation.date} fue aprobada.`,
      rejected:  `Tu reserva de ${reservation.space?.name} para el ${reservation.date} fue rechazada.`,
      cancelled: `Tu reserva de ${reservation.space?.name} para el ${reservation.date} fue cancelada.`,
    };
    firebaseService.sendToUser(reservation.owner._id, {
      title: status === 'approved' ? '✅ Reserva aprobada' : '❌ Reserva actualizada',
      body:  statusMessages[status],
      data:  { type: 'reservation_status', reservationId: reservation._id.toString() },
    }).catch(err => logger.warn(`Push owner reserva falló: ${err.message}`));

    logger.info(`Reserva ${reservation._id} → ${status} por ${req.user.name}`);
    res.json({ success: true, data: { reservation } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/reservations/:id ──────────────────────────────
exports.deleteReservation = async (req, res, next) => {
  try {
    const reservation = await Reservation.findOne({ _id: req.params.id, organization: req.orgId });
    if (!reservation) return res.status(404).json({ success: false, message: 'Reserva no encontrada.' });

    if (req.accessType === 'owner') {
      if (reservation.owner.toString() !== req.ownerId?.toString()) {
        return res.status(403).json({ success: false, message: 'Acceso denegado.' });
      }
      if (!['pending', 'approved'].includes(reservation.status)) {
        return res.status(400).json({ success: false, message: 'Solo podés cancelar reservas pendientes o aprobadas.' });
      }
      // El owner cancela, no elimina
      reservation.status = 'cancelled';
      await reservation.save();
      return res.json({ success: true, message: 'Reserva cancelada.' });
    }

    // Admin elimina definitivamente
    await reservation.deleteOne();
    res.json({ success: true, message: 'Reserva eliminada.' });
  } catch (err) {
    next(err);
  }
};
