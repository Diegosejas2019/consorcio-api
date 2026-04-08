const Payment       = require('../models/Payment');
const User          = require('../models/User');
const Config        = require('../models/Config');
const { cloudinary } = require('../config/cloudinary');
const emailService  = require('../services/emailService');
const firebaseService = require('../services/firebaseService');
const logger        = require('../config/logger');

// ── GET /api/payments — listar (admin: todos; owner: los suyos) ─
exports.getPayments = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, month, ownerId } = req.query;

    const filter = {};
    if (req.user.role === 'owner') filter.owner = req.user._id;
    else if (ownerId) filter.owner = ownerId;
    if (status) filter.status = status;
    if (month)  filter.month  = month;

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .populate('owner', 'name unit email')
        .populate('reviewedBy', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-__v'),
      Payment.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { payments },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/payments/:id ─────────────────────────────────────
exports.getPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('owner', 'name unit email')
      .populate('reviewedBy', 'name');

    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

    // Propietario solo puede ver sus propios pagos
    if (req.user.role === 'owner' && payment.owner._id.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Acceso denegado.' });
    }

    res.json({ success: true, data: { payment } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payments — subir comprobante ────────────────────
exports.createPayment = async (req, res, next) => {
  try {
    const { month, amount, ownerNote } = req.body;
    const ownerId = req.user.role === 'owner' ? req.user._id : req.body.ownerId;

    if (!ownerId) return res.status(400).json({ success: false, message: 'Propietario requerido.' });

    // Verificar que no exista un pago activo para ese período
    const existing = await Payment.findOne({
      owner: ownerId, month,
      status: { $in: ['pending', 'approved'] },
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Ya existe un comprobante ${existing.status === 'approved' ? 'aprobado' : 'pendiente'} para el período ${month}.`,
      });
    }

    // Datos del archivo subido por Cloudinary
    let receiptData;
    if (req.file) {
      receiptData = {
        url:      req.file.path,
        publicId: req.file.filename,
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        size:     req.file.size,
      };
    }

    const payment = await Payment.create({
      owner: ownerId, month,
      amount: Number(amount),
      receipt: receiptData,
      ownerNote,
      paymentMethod: 'manual',
    });

    await payment.populate('owner', 'name unit email');
    logger.info(`Comprobante creado: ${payment._id} — ${payment.owner.name} — ${month}`);

    res.status(201).json({ success: true, data: { payment } });
  } catch (err) {
    // Si Cloudinary subió un archivo pero hubo error, eliminarlo
    if (req.file?.filename) {
      cloudinary.uploader.destroy(req.file.filename).catch(() => {});
    }
    next(err);
  }
};

// ── PATCH /api/payments/:id/approve — aprobar (admin) ─────────
exports.approvePayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id).populate('owner', 'name email unit fcmToken');
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });
    if (payment.status !== 'pending') {
      return res.status(400).json({ success: false, message: `El pago ya fue ${payment.status}.` });
    }

    payment.status      = 'approved';
    payment.reviewedBy  = req.user._id;
    payment.reviewedAt  = new Date();
    await payment.save();

    // Actualizar saldo del propietario
    await User.findByIdAndUpdate(payment.owner._id, { isDebtor: false, balance: 0 });

    // Notificaciones en paralelo (sin bloquear la respuesta)
    Promise.allSettled([
      emailService.sendPaymentApproved(payment.owner, payment),
      firebaseService.sendToUser(payment.owner._id, {
        title: 'Pago aprobado ✓',
        body:  `Tu comprobante de ${payment.monthFormatted} fue aprobado por el administrador.`,
        data:  { type: 'payment_approved', paymentId: payment._id.toString() },
      }),
    ]).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') logger.warn(`Notificación ${i} falló: ${r.reason?.message}`);
      });
    });

    logger.info(`Pago aprobado: ${payment._id} — ${payment.owner.name}`);
    res.json({ success: true, message: 'Pago aprobado correctamente.', data: { payment } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/payments/:id/reject — rechazar (admin) ─────────
exports.rejectPayment = async (req, res, next) => {
  try {
    const { rejectionNote } = req.body;
    if (!rejectionNote?.trim()) {
      return res.status(400).json({ success: false, message: 'El motivo de rechazo es obligatorio.' });
    }

    const payment = await Payment.findById(req.params.id).populate('owner', 'name email unit fcmToken');
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });
    if (payment.status !== 'pending') {
      return res.status(400).json({ success: false, message: `El pago ya fue ${payment.status}.` });
    }

    payment.status        = 'rejected';
    payment.rejectionNote = rejectionNote.trim();
    payment.reviewedBy    = req.user._id;
    payment.reviewedAt    = new Date();
    await payment.save();

    // Notificaciones
    Promise.allSettled([
      emailService.sendPaymentRejected(payment.owner, payment, rejectionNote),
      firebaseService.sendToUser(payment.owner._id, {
        title: 'Comprobante rechazado',
        body:  `Tu comprobante de ${payment.monthFormatted} fue rechazado. Motivo: ${rejectionNote}`,
        data:  { type: 'payment_rejected', paymentId: payment._id.toString() },
      }),
    ]);

    logger.info(`Pago rechazado: ${payment._id} — ${payment.owner.name}`);
    res.json({ success: true, message: 'Pago rechazado.', data: { payment } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/payments/:id/receipt — descargar comprobante ─────
exports.getReceipt = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

    // Propietario solo puede ver sus propios comprobantes
    if (req.user.role === 'owner' && payment.owner.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Acceso denegado.' });
    }

    if (!payment.receipt?.url) {
      return res.status(404).json({ success: false, message: 'Este pago no tiene comprobante adjunto.' });
    }

    // Generar URL firmada de Cloudinary con expiración de 5 minutos
    const signedUrl = cloudinary.utils.private_download_url(
      payment.receipt.publicId,
      'pdf',
      {
        resource_type: 'raw',
        expires_at:    Math.floor(Date.now() / 1000) + 300,
        attachment:    payment.receipt.filename || true,
      }
    );

    res.redirect(signedUrl);
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/payments/:id — eliminar comprobante ───────────
exports.deletePayment = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

    // Propietario solo puede borrar sus pagos pendientes
    if (req.user.role === 'owner') {
      if (payment.owner.toString() !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Acceso denegado.' });
      }
      if (payment.status !== 'pending') {
        return res.status(400).json({ success: false, message: 'Solo podés eliminar comprobantes pendientes.' });
      }
    }

    // Eliminar archivo de Cloudinary
    if (payment.receipt?.publicId) {
      const resourceType = payment.receipt.mimetype === 'application/pdf' ? 'raw' : 'image';
      await cloudinary.uploader.destroy(payment.receipt.publicId, { resource_type: resourceType });
    }

    await payment.deleteOne();
    res.json({ success: true, message: 'Comprobante eliminado.' });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/payments/dashboard — stats para admin ────────────
exports.getDashboard = async (req, res, next) => {
  try {
    const [monthly, byStatus] = await Promise.all([
      Payment.aggregate([
        { $match: { status: 'approved' } },
        { $group: { _id: '$month', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { _id: -1 } },
        { $limit: 6 },
      ]),
      Payment.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    const statusMap = {};
    byStatus.forEach(s => { statusMap[s._id] = s.count; });

    res.json({
      success: true,
      data: {
        monthly: monthly.reverse(),
        pending:  statusMap.pending  || 0,
        approved: statusMap.approved || 0,
        rejected: statusMap.rejected || 0,
      },
    });
  } catch (err) {
    next(err);
  }
};
