const Payment         = require('../models/Payment');
const Expense         = require('../models/Expense');
const User            = require('../models/User');
const Unit            = require('../models/Unit');
const Organization    = require('../models/Organization');
const { calcUnitFee } = require('./unitController');
const { cloudinary }  = require('../config/cloudinary');
const emailService    = require('../services/emailService');
const firebaseService = require('../services/firebaseService');
const receiptService  = require('../services/receiptService');
const { sendDueDateReminders } = require('../services/schedulerService');
const logger          = require('../config/logger');

// ── GET /api/payments — listar (admin: todos; owner: los suyos) ─
exports.getPayments = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, month, ownerId } = req.query;

    const filter = { organization: req.orgId };
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
    const payment = await Payment.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name unit email')
      .populate('reviewedBy', 'name');

    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

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
    const { month, ownerNote } = req.body;
    let { amount } = req.body;
    const ownerId = req.user.role === 'owner' ? req.user._id : req.body.ownerId;

    if (!ownerId) return res.status(400).json({ success: false, message: 'Propietario requerido.' });

    // Cargar unidades activas del propietario para calcular monto y breakdown
    const [org, activeUnits, ownerDoc] = await Promise.all([
      Organization.findById(req.orgId).select('monthlyFee'),
      Unit.find({ owner: ownerId, active: true, organization: req.orgId }).sort({ name: 1 }),
      User.findById(ownerId).select('startBillingPeriod'),
    ]);

    // Validar que el período no sea anterior al inicio de cobro del propietario
    const startBilling = ownerDoc?.startBillingPeriod;
    if (startBilling && month < startBilling) {
      return res.status(400).json({
        success: false,
        message: `No se pueden registrar pagos anteriores al período de inicio de cobro del propietario (${startBilling}).`,
      });
    }

    const monthlyFee = org?.monthlyFee ?? 0;

    // Si no viene amount, calcularlo desde las unidades (o usar monthlyFee si no hay unidades)
    if (amount === undefined || amount === null || amount === '') {
      if (activeUnits.length > 0) {
        amount = activeUnits.reduce((sum, u) => sum + calcUnitFee(u, monthlyFee), 0);
      } else {
        amount = monthlyFee;
      }
    }

    const existing = await Payment.findOne({
      organization: req.orgId,
      owner: ownerId,
      month,
      status: { $in: ['pending', 'approved'] },
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Ya existe un comprobante ${existing.status === 'approved' ? 'aprobado' : 'pendiente'} para el período ${month}.`,
      });
    }

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

    // Snapshot de unidades al momento del pago
    const unitsSnapshot   = activeUnits.map(u => u._id);
    const breakdownSnapshot = activeUnits.map(u => ({
      unit:   u._id,
      name:   u.name,
      amount: calcUnitFee(u, monthlyFee),
    }));

    const payment = await Payment.create({
      organization: req.orgId,
      owner:        ownerId,
      month,
      amount:       Number(amount),
      receipt:      receiptData,
      ownerNote,
      paymentMethod: 'manual',
      units:         unitsSnapshot,
      breakdown:     breakdownSnapshot,
    });

    await payment.populate('owner', 'name unit email');
    logger.info(`Comprobante creado: ${payment._id} — ${payment.owner.name} — ${month}`);

    res.status(201).json({ success: true, data: { payment } });
  } catch (err) {
    if (req.file?.filename) {
      cloudinary.uploader.destroy(req.file.filename).catch(() => {});
    }
    next(err);
  }
};

// ── PATCH /api/payments/:id/approve — aprobar (admin) ─────────
exports.approvePayment = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name email unit fcmToken');
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });
    if (payment.status !== 'pending') {
      const statusLabel = { approved: 'aprobado', rejected: 'rechazado' }[payment.status] ?? payment.status;
      return res.status(400).json({ success: false, message: `El pago ya fue ${statusLabel}.` });
    }

    payment.status      = 'approved';
    payment.reviewedBy  = req.user._id;
    payment.reviewedAt  = new Date();
    await payment.save();

    await User.findByIdAndUpdate(payment.owner._id, { isDebtor: false, balance: 0 });

    // Generar recibo del sistema de forma asíncrona (no bloquea la aprobación)
    if (!payment.systemReceipt?.url) {
      receiptService.generateAndStoreReceipt(payment._id)
        .then(async (updatedPayment) => {
          const receiptUrl = updatedPayment.systemReceipt?.url;
          await Promise.allSettled([
            emailService.sendReceiptEmail(payment.owner, updatedPayment, receiptUrl),
            emailService.sendPaymentApproved(payment.owner, updatedPayment),
            firebaseService.sendToUser(payment.owner._id, {
              title: 'Pago aprobado ✓',
              body:  `Tu comprobante de ${payment.monthFormatted} fue aprobado por el administrador.`,
              data:  { type: 'payment_approved', paymentId: payment._id.toString() },
            }),
          ]);
        })
        .catch(err => logger.error(`[approvePayment] Error generando recibo ${payment._id}: ${err.message}`));
    } else {
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
    }

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

    const payment = await Payment.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name email unit fcmToken');
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });
    if (payment.status !== 'pending') {
      const statusLabel = { approved: 'aprobado', rejected: 'rechazado' }[payment.status] ?? payment.status;
      return res.status(400).json({ success: false, message: `El pago ya fue ${statusLabel}.` });
    }

    payment.status        = 'rejected';
    payment.rejectionNote = rejectionNote.trim();
    payment.reviewedBy    = req.user._id;
    payment.reviewedAt    = new Date();
    await payment.save();

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

// ── GET /api/payments/:id/receipt — descargar comprobante subido ─
exports.getReceipt = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, organization: req.orgId });
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

    if (req.user.role === 'owner' && payment.owner.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Acceso denegado.' });
    }

    if (!payment.receipt?.url) {
      return res.status(404).json({ success: false, message: 'Este pago no tiene comprobante adjunto.' });
    }

    const mimetype     = payment.receipt.mimetype || 'application/pdf';
    const isImage      = mimetype.startsWith('image/');
    const resourceType = isImage ? 'image' : 'raw';
    const format       = isImage
      ? (mimetype.split('/')[1] === 'jpeg' ? 'jpg' : mimetype.split('/')[1])
      : 'pdf';
    const deliveryType = payment.receipt.url.includes('/authenticated/') ? 'authenticated' : 'upload';

    const signedUrl = cloudinary.utils.private_download_url(
      payment.receipt.publicId,
      format,
      {
        resource_type: resourceType,
        type:          deliveryType,
        expires_at:    Math.floor(Date.now() / 1000) + 120,
      }
    );

    const cloudRes = await fetch(signedUrl);
    if (!cloudRes.ok) {
      logger.error(`Cloudinary proxy error: ${cloudRes.status} — publicId: ${payment.receipt.publicId}`);
      return res.status(502).json({ success: false, message: 'No se pudo obtener el comprobante desde Cloudinary.' });
    }

    const fallbackName = `comprobante.${format}`;
    const filename     = (payment.receipt.filename || fallbackName).replace(/"/g, '');
    res.setHeader('Content-Type', mimetype);
    const disposition = isImage ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);

    const contentLength = cloudRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const { Readable } = require('stream');
    Readable.fromWeb(cloudRes.body).pipe(res);
  } catch (err) {
    next(err);
  }
};

// ── GET /api/payments/:id/system-receipt — recibo generado por el sistema ─
exports.getSystemReceipt = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, organization: req.orgId });
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

    if (req.user.role === 'owner' && payment.owner.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Acceso denegado.' });
    }

    if (!payment.systemReceipt?.url) {
      return res.status(404).json({ success: false, message: 'El recibo aún no fue generado.' });
    }

    res.json({
      success: true,
      data: {
        receiptNumber:   payment.receiptNumber,
        receiptIssuedAt: payment.receiptIssuedAt,
        url:             payment.systemReceipt.url,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/payments/:id — eliminar comprobante ───────────
exports.deletePayment = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, organization: req.orgId });
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

    if (req.user.role === 'owner') {
      if (payment.owner.toString() !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Acceso denegado.' });
      }
      if (payment.status !== 'pending') {
        return res.status(400).json({ success: false, message: 'Solo podés eliminar comprobantes pendientes.' });
      }
    }

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
    const year       = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    const startMonth = `${year}-01`;
    const endMonth   = `${year}-12`;
    const orgFilter  = { organization: req.orgId };

    const yearStart = new Date(`${year}-01-01`);
    const yearEnd   = new Date(`${year}-12-31T23:59:59.999Z`);

    const [monthly, byStatus, expensesAgg] = await Promise.all([
      Payment.aggregate([
        { $match: { ...orgFilter, month: { $gte: startMonth, $lte: endMonth } } },
        { $group: { _id: { month: '$month', status: '$status' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { '_id.month': 1 } },
      ]),
      Payment.aggregate([
        { $match: orgFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Expense.aggregate([
        { $match: { ...orgFilter, status: 'paid', date: { $gte: yearStart, $lte: yearEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const monthMap = {};
    monthly.forEach(({ _id: { month, status }, total, count }) => {
      if (!monthMap[month]) monthMap[month] = { _id: month, total: 0, count: 0, pending: 0, rejected: 0 };
      if (status === 'approved') { monthMap[month].total = total; monthMap[month].count = count; }
      else if (status === 'pending')  monthMap[month].pending  = count;
      else if (status === 'rejected') monthMap[month].rejected = count;
    });
    const monthlyArr = Object.values(monthMap).sort((a, b) => a._id.localeCompare(b._id));

    const statusMap = {};
    byStatus.forEach(s => { statusMap[s._id] = s.count; });

    const totalExpenses = expensesAgg[0]?.total || 0;
    const totalYear     = monthlyArr.reduce((sum, m) => sum + m.total, 0);

    res.json({
      success: true,
      data: {
        monthly:       monthlyArr,
        pending:       statusMap.pending  || 0,
        approved:      statusMap.approved || 0,
        rejected:      statusMap.rejected || 0,
        totalExpenses,
        balance:       totalYear - totalExpenses,
        year,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payments/:id/resend-receipt — reenviar recibo (admin) ─
exports.resendReceipt = async (req, res, next) => {
  try {
    const payment = await Payment.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name email unit');
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });
    if (payment.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Solo se puede reenviar el recibo de pagos aprobados.' });
    }

    let updated = payment;
    if (!payment.systemReceipt?.url) {
      updated = await receiptService.generateAndStoreReceipt(payment._id);
      await updated.populate('owner', 'name email unit');
    }

    await emailService.sendReceiptEmail(updated.owner, updated, updated.systemReceipt.url);

    logger.info(`[resendReceipt] Recibo reenviado: ${updated.receiptNumber} → ${updated.owner.email}`);
    res.json({ success: true, message: 'Recibo reenviado por email correctamente.' });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payments/send-reminders — trigger manual (admin) ─
exports.sendReminders = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.orgId);
    if (!org) return res.status(404).json({ success: false, message: 'Organización no encontrada' });

    const result = await sendDueDateReminders(org);
    logger.info(`[sendReminders] Manual: ${JSON.stringify(result)}`);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};
