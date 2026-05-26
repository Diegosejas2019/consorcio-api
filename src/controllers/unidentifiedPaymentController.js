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

exports.importBankStatement = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Se requiere un archivo .csv o .xlsx.' });
    }

    const preview = req.query.preview === 'true';

    let parsed;
    try {
      parsed = unidentifiedPaymentService.parseStatementFile(req.file.buffer, req.file.originalname);
    } catch {
      return res.status(400).json({ success: false, message: 'El archivo no pudo leerse. Verificá que sea un CSV o Excel válido.' });
    }

    const { rows } = parsed;
    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'El archivo está vacío o no contiene filas de datos.' });
    }
    if (rows.length > 500) {
      return res.status(400).json({ success: false, message: `El archivo supera el límite de 500 filas (tiene ${rows.length}).` });
    }

    const results = rows.map((row, i) => {
      const { data, error } = unidentifiedPaymentService.validateRow(row, i + 2);
      return error
        ? { rowNumber: i + 2, status: 'invalid', error }
        : { rowNumber: i + 2, status: 'valid', data };
    });

    const validResults = results.filter(r => r.status === 'valid');
    const duplicateNums = await unidentifiedPaymentService.checkBulkDuplicates(
      validResults.map(r => r.data),
      req.orgId
    );

    for (const r of validResults) {
      if (duplicateNums.has(r.rowNumber)) {
        r.status = 'duplicate';
        r.warning = 'Posible duplicado detectado (mismo importe, fecha y referencia en los últimos 7 días)';
      }
    }

    const valid = results.filter(r => r.status === 'valid');
    const invalid = results.filter(r => r.status === 'invalid');
    const duplicates = results.filter(r => r.status === 'duplicate');
    const totalAmount = valid.reduce((s, r) => s + r.data.amount, 0);

    if (preview) {
      return res.json({
        success: true,
        data: {
          preview: true,
          total: rows.length,
          validCount: valid.length,
          invalidCount: invalid.length,
          duplicatesCount: duplicates.length,
          totalAmount,
          rows: results.slice(0, 100),
        },
      });
    }

    if (!valid.length) {
      return res.status(400).json({
        success: false,
        message: 'No hay filas válidas para importar.',
        data: {
          total: rows.length,
          validCount: 0,
          invalidCount: invalid.length,
          duplicatesCount: duplicates.length,
        },
      });
    }

    const { created, ids } = await unidentifiedPaymentService.bulkCreateStatements(
      req.orgId,
      req.user.id,
      valid.map(r => r.data),
      req.file.originalname
    );

    res.status(201).json({
      success: true,
      data: {
        imported: created,
        skipped: invalid.length + duplicates.length,
        invalidCount: invalid.length,
        duplicatesCount: duplicates.length,
        ids,
      },
    });
  } catch (err) {
    next(err);
  }
};