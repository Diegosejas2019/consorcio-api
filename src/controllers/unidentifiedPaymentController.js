const { cloudinary } = require('../config/cloudinary');
const unidentifiedPaymentService = require('../services/unidentifiedPaymentService');

const processAttachments = (files) => {
  if (!files || files.length === 0) return [];
  return files.map(f => ({
    url: f.path,
    publicId: f.filename,
    filename: f.originalname,
    mimetype: f.mimetype,
    size: f.size,
    uploadedBy: undefined,
    uploadedAt: new Date(),
  }));
};

exports.getUnidentifiedPayments = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, paymentMethod, dateFrom, dateTo, amountMin, amountMax, search } = req.query;

    const filters = { status, paymentMethod, dateFrom, dateTo, amountMin, amountMax, search };
    const pagination = { page: Number(page), limit: Number(limit) };

    const result = await unidentifiedPaymentService.getUnidentifiedPayments(req.orgId, filters, pagination);

    res.json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (err) {
    next(err);
  }
};

exports.getSummary = async (req, res, next) => {
  try {
    const UnidentifiedPayment = require('../models/UnidentifiedPayment');

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [pendingCount, pendingResult, associatedThisMonthCount, rejectedArchivedCount] = await Promise.all([
      UnidentifiedPayment.countDocuments({ organization: req.orgId, isDeleted: false, status: 'pending' }),
      UnidentifiedPayment.aggregate([
        { $match: { organization: req.orgId, isDeleted: false, status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      UnidentifiedPayment.countDocuments({
        organization: req.orgId,
        isDeleted: false,
        status: 'associated',
        associatedAt: { $gte: startOfMonth },
      }),
      UnidentifiedPayment.countDocuments({
        organization: req.orgId,
        isDeleted: false,
        status: { $in: ['rejected', 'archived'] },
      }),
    ]);

    res.json({
      success: true,
      data: {
        pendingCount,
        pendingAmount: pendingResult[0]?.total || 0,
        associatedThisMonth: associatedThisMonthCount,
        rejectedArchivedCount,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.getUnidentifiedPayment = async (req, res, next) => {
  try {
    const payment = await unidentifiedPaymentService.getUnidentifiedPaymentById(req.params.id, req.orgId);
    res.json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
};

exports.createUnidentifiedPayment = async (req, res, next) => {
  try {
    const attachments = processAttachments(req.files);

    const duplicateCheck = await unidentifiedPaymentService.detectPossibleDuplicate(
      { ...req.body },
      req.orgId
    );

    const data = { ...req.body, attachments };
    const payment = await unidentifiedPaymentService.createUnidentifiedPayment(req.orgId, data, req.user.id);

    const response = { success: true, data: payment };
    if (duplicateCheck.hasDuplicate) {
      response.warning = {
        message: 'Posible duplicado detectado',
        duplicate: duplicateCheck.duplicate,
      };
    }

    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
};

exports.updateUnidentifiedPayment = async (req, res, next) => {
  try {
    const existingPayment = await require('../models/UnidentifiedPayment').findOne({
      _id: req.params.id,
      organization: req.orgId,
      isDeleted: false,
    });

    if (!existingPayment) {
      return res.status(404).json({ success: false, message: 'No se encontró el pago no identificado' });
    }

    if (existingPayment.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Solo se pueden editar pagos en estado pendiente' });
    }

    const attachments = processAttachments(req.files);
    const data = attachments.length > 0 ? { ...req.body, attachments } : req.body;

    const payment = await unidentifiedPaymentService.updateUnidentifiedPayment(req.params.id, data, req.user.id);
    res.json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
};

exports.deleteUnidentifiedPayment = async (req, res, next) => {
  try {
    const existingPayment = await require('../models/UnidentifiedPayment').findOne({
      _id: req.params.id,
      organization: req.orgId,
      isDeleted: false,
    });

    if (!existingPayment) {
      return res.status(404).json({ success: false, message: 'No se encontró el pago no identificado' });
    }

    if (existingPayment.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Solo se pueden eliminar pagos en estado pendiente' });
    }

    await unidentifiedPaymentService.softDeleteUnidentifiedPayment(req.params.id, req.user.id);
    res.json({ success: true, message: 'Pago no identificado eliminado correctamente' });
  } catch (err) {
    next(err);
  }
};

exports.getSuggestions = async (req, res, next) => {
  try {
    const suggestions = await unidentifiedPaymentService.findPaymentMatchSuggestions(req.orgId, req.params.id);
    res.json({ success: true, data: suggestions });
  } catch (err) {
    next(err);
  }
};

exports.associatePayment = async (req, res, next) => {
  try {
    const { ownerId, unitId, period, amountApplied } = req.body;

    if (!ownerId) {
      return res.status(400).json({ success: false, message: 'El propietario es obligatorio' });
    }

    const payment = await unidentifiedPaymentService.associateUnidentifiedPayment(
      req.params.id,
      { ownerId, unitId, period, amountApplied },
      req.user.id
    );

    res.json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
};

exports.rejectPayment = async (req, res, next) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ success: false, message: 'El motivo del rechazo es obligatorio' });
    }

    const payment = await unidentifiedPaymentService.rejectUnidentifiedPayment(req.params.id, reason, req.user.id);
    res.json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
};

exports.archivePayment = async (req, res, next) => {
  try {
    const reason = req.body.reason || '';

    const payment = await unidentifiedPaymentService.archiveUnidentifiedPayment(req.params.id, reason, req.user.id);
    res.json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
};