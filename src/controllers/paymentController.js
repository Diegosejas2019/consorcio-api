const Payment            = require('../models/Payment');
const Expense            = require('../models/Expense');
const User               = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Unit               = require('../models/Unit');
const Organization       = require('../models/Organization');
const { calcUnitFee } = require('./unitController');
const { cloudinary }  = require('../config/cloudinary');
const emailService    = require('../services/emailService');
const firebaseService = require('../services/firebaseService');
const receiptService  = require('../services/receiptService');
const { sendDueDateReminders } = require('../services/schedulerService');
const { calculateExtraordinaryAmountForOwner } = require('../services/expenseService');
const { currentYYYYMM } = require('../utils/periods');
const logger          = require('../config/logger');

const getCloudinaryRawPublicIdFromUrl = (url) => {
  if (!url) return null;
  try {
    const { pathname } = new URL(url);
    const uploadMarker = '/raw/upload/';
    const uploadIndex = pathname.indexOf(uploadMarker);
    if (uploadIndex === -1) return null;

    const afterUpload = pathname.slice(uploadIndex + uploadMarker.length);
    const withoutVersion = afterUpload.replace(/^v\d+\//, '');
    return decodeURIComponent(withoutVersion).replace(/\.pdf$/i, '');
  } catch {
    return null;
  }
};

const buildSystemReceiptDownloadUrl = (systemReceipt) => {
  const publicId = systemReceipt?.publicId || getCloudinaryRawPublicIdFromUrl(systemReceipt?.url);
  if (!publicId) return systemReceipt?.url;

  return cloudinary.utils.private_download_url(
    publicId,
    'pdf',
    {
      resource_type: 'raw',
      type:          'upload',
      expires_at:    Math.floor(Date.now() / 1000) + 120,
    }
  );
};

const formatReceiptDownloadDate = (date = new Date()) => {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day:      '2-digit',
    month:    '2-digit',
    year:     'numeric',
  }).format(date).replace(/\//g, '-');
};

const buildAvailablePaymentItems = async ({ organizationId, owner, membership }) => {
  const [org, activePayments, ownerUnits, allOrgUnits] = await Promise.all([
    Organization.findById(organizationId).select('paymentPeriods feePeriodCode monthlyFee'),
    Payment.find({
      organization: organizationId,
      owner:        owner._id,
      status:       { $in: ['pending', 'approved'] },
    }).select('month extraordinaryItems'),
    Unit.find({ owner: owner._id, organization: organizationId, active: true }).lean(),
    Unit.find({ organization: organizationId, active: true }).lean(),
  ]);

  const paidMonths = new Set(activePayments.map(p => p.month).filter(Boolean));
  const paidExtraIds = new Set(
    activePayments.flatMap(p => (p.extraordinaryItems || [])
      .map(e => e.expense?.toString())
      .filter(Boolean))
  );

  const startBilling  = membership?.startBillingPeriod ?? owner.startBillingPeriod;
  const currentPeriod = currentYYYYMM();
  const periods = (org?.paymentPeriods || [])
    .filter(p => !paidMonths.has(p) && (!startBilling || p >= startBilling) && p <= currentPeriod);

  const extras = await Expense.find({
    organization: organizationId,
    expenseType:  'extraordinary',
    isChargeable: true,
    isActive:     { $ne: false },
  }).select('_id description amount date extraordinaryBillingMode unitAmount appliesToAllOwners targetUnits').sort({ date: -1, createdAt: -1 }).lean();

  const extraordinary = extras
    .filter(e => !paidExtraIds.has(e._id.toString()))
    .map(e => {
      const { amountForOwner } = calculateExtraordinaryAmountForOwner(e, ownerUnits, allOrgUnits);
      // Omitir si el owner no tiene unidades aplicables (solo en modos que requieren unidades)
      if (amountForOwner === 0 && (e.extraordinaryBillingMode === 'per_unit' || e.extraordinaryBillingMode === 'by_coefficient')) {
        return null;
      }
      return {
        id:                      e._id,
        _id:                     e._id,
        title:                   e.description,
        description:             e.description,
        amount:                  amountForOwner,
        extraordinaryBillingMode: e.extraordinaryBillingMode || 'fixed_total',
        period:                  e.date ? e.date.toISOString().slice(0, 7) : null,
        date:                    e.date,
      };
    })
    .filter(Boolean);

  return { periods, extraordinary };
};

// ── GET /api/payments — listar (admin: todos; owner: los suyos) ─
exports.getPayments = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, month, ownerId, effectiveMonth } = req.query;

    const filter = { organization: req.orgId };
    if (req.user.role === 'owner') filter.owner = req.user._id;
    else if (ownerId) filter.owner = ownerId;
    if (status) filter.status = status;
    if (month)  filter.month  = month;
    if (effectiveMonth) {
      const [yr, mo] = effectiveMonth.split('-');
      const monthStart = new Date(`${yr}-${mo}-01T00:00:00.000Z`);
      const monthEnd   = new Date(monthStart);
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
      filter.$or = [
        { month: effectiveMonth },
        { month: { $exists: false }, createdAt: { $gte: monthStart, $lt: monthEnd } },
      ];
    }

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .populate('owner', 'name unit email')
        .populate('reviewedBy', 'name')
        .populate('extraordinaryItems.expense', 'description amount date attachments')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-__v'),
      Payment.countDocuments(filter),
    ]);

    const data = { payments };
    if (req.user.role === 'owner') {
      const availableItems = await buildAvailablePaymentItems({
        organizationId: req.orgId,
        owner:          req.user,
        membership:     req.membership,
      });
      data.availableItems = availableItems;
      data.periods = availableItems.periods;
      data.extraordinary = availableItems.extraordinary;
      data.extraordinaryExpenses = availableItems.extraordinary;
    }

    res.json({
      success: true,
      data,
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
      .populate('reviewedBy', 'name')
      .populate('extraordinaryItems.expense', 'description amount date attachments');

    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

    if (req.user.role === 'owner' && payment.owner._id.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Acceso denegado.' });
    }

    res.json({ success: true, data: { payment } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/payments/available-items — períodos y extraordinarios disponibles ─
exports.getAvailableItems = async (req, res, next) => {
  try {
    const { periods, extraordinary } = await buildAvailablePaymentItems({
      organizationId: req.orgId,
      owner:          req.user,
      membership:     req.membership,
    });
    res.json({ success: true, data: { periods, extraordinary } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payments — subir comprobante ────────────────────
exports.createPayment = async (req, res, next) => {
  try {
    let { month, ownerNote } = req.body;
    let { amount } = req.body;
    let balanceAmount = Number(req.body.balanceAmount || 0);
    const ownerId = req.user.role === 'owner' ? req.user._id : req.body.ownerId;

    // Parse extraordinaryIds: puede venir como string JSON, array, o múltiples campos
    let extraordinaryIds = req.body.extraordinaryIds;
    if (typeof extraordinaryIds === 'string') {
      try { extraordinaryIds = JSON.parse(extraordinaryIds); } catch { extraordinaryIds = [extraordinaryIds]; }
    }
    if (!Array.isArray(extraordinaryIds)) extraordinaryIds = extraordinaryIds ? [extraordinaryIds] : [];

    if (!ownerId) return res.status(400).json({ success: false, message: 'Propietario requerido.' });

    // Cargar unidades activas del propietario para calcular monto y breakdown
    const [org, activeUnits, ownerMembership, allOrgUnits] = await Promise.all([
      Organization.findById(req.orgId).select('monthlyFee feePeriodCode'),
      Unit.find({ owner: ownerId, active: true, organization: req.orgId }).sort({ name: 1 }),
      OrganizationMember.findOne({ user: ownerId, organization: req.orgId, role: 'owner' }).select('startBillingPeriod balance'),
      Unit.find({ organization: req.orgId, active: true }).lean(),
    ]);

    if (!month && extraordinaryIds.length === 0 && balanceAmount <= 0) {
      if (!amount || Number(amount) < 1) {
        return res.status(400).json({ success: false, message: 'El período o importe son obligatorios.' });
      }
      // balance payment — continúa
    }

    if (!month && extraordinaryIds.length === 0 && balanceAmount <= 0) {
      balanceAmount = Number(amount);
    }

    const monthlyFee = org?.monthlyFee ?? 0;

    if (balanceAmount > 0) {
      const currentDebt = Math.abs(Math.min(Number(ownerMembership?.balance || 0), 0));
      if (currentDebt <= 0) {
        return res.status(400).json({ success: false, message: 'No hay saldo anterior pendiente para pagar.' });
      }
      if (balanceAmount > currentDebt) {
        return res.status(400).json({ success: false, message: 'El importe no puede superar el saldo anterior pendiente.' });
      }
      const pendingBalance = await Payment.findOne({
        organization: req.orgId,
        owner:        ownerId,
        type:         'balance',
        status:       'pending',
      });
      if (pendingBalance) {
        return res.status(400).json({ success: false, message: 'Ya tenes un pago de saldo anterior pendiente.' });
      }
    }

    // Validar que el período no sea anterior al inicio de cobro del propietario
    if (month) {
      const currentPeriod = currentYYYYMM();
      if (month > currentPeriod) {
        return res.status(400).json({
          success: false,
          message: 'No se pueden registrar pagos de períodos futuros.',
        });
      }

      const startBilling = ownerMembership?.startBillingPeriod;
      if (startBilling && month < startBilling) {
        return res.status(400).json({
          success: false,
          message: `No se pueden registrar pagos anteriores al período de inicio de cobro del propietario (${startBilling}).`,
        });
      }
    }

    // Si no viene amount, calcularlo desde las unidades (solo si hay período mensual)
    if (amount === undefined || amount === null || amount === '') {
      if (month) {
        amount = activeUnits.length > 0
          ? activeUnits.reduce((sum, u) => sum + calcUnitFee(u, monthlyFee), 0)
          : monthlyFee;
      } else {
        amount = 0; // solo-extraordinarios: la suma se agrega abajo
      }
    }

    // Sumar conceptos extraordinarios
    let extraordinaryItems = [];
    if (extraordinaryIds.length > 0) {
      const expenses = await Expense.find({
        _id:          { $in: extraordinaryIds },
        organization: req.orgId,
        expenseType:  'extraordinary',
        isChargeable: true,
        isActive:     { $ne: false },
      }).select('_id amount extraordinaryBillingMode unitAmount appliesToAllOwners targetUnits').lean();

      if (expenses.length !== extraordinaryIds.length) {
        return res.status(400).json({ success: false, message: 'Uno o más conceptos extraordinarios no son válidos.' });
      }

      // Verificar que no estén ya pagados por este propietario
      const alreadyPaid = await Payment.findOne({
        organization: req.orgId,
        owner:        ownerId,
        status:       { $in: ['pending', 'approved'] },
        'extraordinaryItems.expense': { $in: extraordinaryIds },
      });
      if (alreadyPaid) {
        return res.status(400).json({ success: false, message: 'Uno o más conceptos extraordinarios ya tienen un pago activo.' });
      }

      extraordinaryItems = expenses.map(e => {
        const { amountForOwner } = calculateExtraordinaryAmountForOwner(e, activeUnits, allOrgUnits);
        return { expense: e._id, amount: amountForOwner };
      });
      amount = Number(amount) + extraordinaryItems.reduce((s, e) => s + e.amount, 0);
    }

    if (month) {
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

    if (!month && extraordinaryIds.length === 0 && balanceAmount > 0) {
      amount = balanceAmount;
    }

    const paymentType = (!month && extraordinaryIds.length === 0)
      ? 'balance'
      : (!month ? 'extraordinary' : 'monthly');

    // Snapshot de unidades al momento del pago (no aplica a pagos de saldo anterior)
    const unitsSnapshot     = paymentType !== 'balance' ? activeUnits.map(u => u._id) : [];
    const breakdownSnapshot = paymentType !== 'balance' ? activeUnits.map(u => ({
      unit:   u._id,
      name:   u.name,
      amount: calcUnitFee(u, monthlyFee),
    })) : [];

    const payment = await Payment.create({
      organization:      req.orgId,
      owner:             ownerId,
      membership:        ownerMembership?._id,
      month,
      amount:            Number(amount),
      receipt:           receiptData,
      ownerNote,
      paymentMethod:     'manual',
      type:              paymentType,
      units:             unitsSnapshot,
      breakdown:         breakdownSnapshot,
      extraordinaryItems,
      createdBy:         req.user._id,
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
    payment.approvedBy  = req.user._id;
    await payment.save();

    if (payment.type === 'balance') {
      const updatedMember = await OrganizationMember.findOneAndUpdate(
        { user: payment.owner._id, organization: payment.organization, role: 'owner' },
        { $inc: { balance: payment.amount } },
        { new: true }
      );
      if ((updatedMember?.balance ?? -1) >= 0) {
        await OrganizationMember.updateOne(
          { user: payment.owner._id, organization: payment.organization, role: 'owner' },
          { isDebtor: false, balance: 0 }
        );
      }
    } else {
      await OrganizationMember.updateOne(
        { user: payment.owner._id, organization: payment.organization, role: 'owner' },
        { isDebtor: false, balance: 0 }
      );
    }

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

    logger.info('Payment approved', { paymentId: payment._id, approvedBy: req.user._id });
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
    payment.rejectedBy    = req.user._id;
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

    const ownsPayment = payment.owner?.toString() === req.user.id
      || (req.membership?._id && payment.membership?.toString() === req.membership._id.toString());

    if (req.user.role === 'owner' && !ownsPayment) {
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

    const ownsPayment = payment.owner?.toString() === req.user.id
      || (req.membership?._id && payment.membership?.toString() === req.membership._id.toString());

    if (req.user.role === 'owner' && !ownsPayment) {
      return res.status(403).json({ success: false, message: 'Acceso denegado.' });
    }

    if (payment.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Solo se puede descargar el recibo de pagos aprobados.' });
    }

    let receiptPayment = payment;
    if (!payment.systemReceipt?.url) {
      receiptPayment = await receiptService.generateAndStoreReceipt(payment._id);
    }

    if (req.query.download === '1') {
      const receiptUrl = buildSystemReceiptDownloadUrl(receiptPayment.systemReceipt);
      const cloudRes = await fetch(receiptUrl);
      if (!cloudRes.ok) {
        const cloudinaryError = cloudRes.headers.get('x-cld-error');
        logger.error(`System receipt proxy error: ${cloudRes.status}${cloudinaryError ? ` - ${cloudinaryError}` : ''} - paymentId: ${payment._id}`);
        return res.status(502).json({ success: false, message: 'No se pudo obtener el recibo desde Cloudinary.' });
      }

      const filename = `recibo_${formatReceiptDownloadDate()}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const contentLength = cloudRes.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);

      const { Readable } = require('stream');
      Readable.fromWeb(cloudRes.body).pipe(res);
      return;
    }

    res.json({
      success: true,
      data: {
        receiptNumber:   receiptPayment.receiptNumber,
        receiptIssuedAt: receiptPayment.receiptIssuedAt,
        url:             receiptPayment.systemReceipt.url,
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
        {
          $match: {
            ...orgFilter,
            $or: [
              { month: { $gte: startMonth, $lte: endMonth } },
              { month: { $exists: false }, createdAt: { $gte: yearStart, $lte: yearEnd } },
            ],
          },
        },
        {
          $addFields: {
            effectiveMonth: {
              $ifNull: ['$month', { $dateToString: { format: '%Y-%m', date: '$createdAt' } }],
            },
          },
        },
        { $group: { _id: { month: '$effectiveMonth', status: '$status' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { '_id.month': 1 } },
      ]),
      Payment.aggregate([
        { $match: orgFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Expense.aggregate([
        { $match: { ...orgFilter, status: 'paid', isActive: { $ne: false }, date: { $gte: yearStart, $lte: yearEnd } } },
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
