const Expense  = require('../models/Expense');
const Provider = require('../models/Provider');
const logger   = require('../config/logger');
const { cloudinary } = require('../config/cloudinary');

const CATEGORY_LABELS = {
  cleaning:       'Limpieza',
  security:       'Seguridad',
  maintenance:    'Mantenimiento',
  utilities:      'Servicios',
  administration: 'Administración',
  other:          'Otros',
};

// ── GET /api/expenses/summary — resumen por categoría (owners y admin) ──
exports.getExpensesSummary = async (req, res, next) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
    const from  = new Date(`${month}-01T00:00:00.000Z`);
    const to    = new Date(from);
    to.setMonth(to.getMonth() + 1);

    const agg = await Expense.aggregate([
      { $match: { organization: req.orgId, date: { $gte: from, $lt: to } } },
      { $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]);

    const total = agg.reduce((s, c) => s + c.amount, 0);
    const categories = agg.map(c => ({
      category: c._id,
      label:    CATEGORY_LABELS[c._id] || c._id,
      amount:   c.amount,
      count:    c.count,
    }));

    res.json({ success: true, data: { month, total, categories } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/expenses ─────────────────────────────────────────
exports.getExpenses = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, month, category, status } = req.query;

    const filter = { organization: req.orgId };
    if (month)    filter.date = { $gte: new Date(`${month}-01`), $lte: new Date(`${month}-31`) };
    if (category) filter.category = category;
    if (status)   filter.status   = status;

    const [expenses, total] = await Promise.all([
      Expense.find(filter)
        .populate('provider', 'name serviceType cuit')
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-__v'),
      Expense.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { expenses },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/expenses ────────────────────────────────────────
exports.createExpense = async (req, res, next) => {
  try {
    const allowed = ['description', 'category', 'amount', 'date', 'provider', 'paymentMethod', 'expenseType', 'invoiceNumber', 'invoiceCuit'];
    const data    = { organization: req.orgId, createdBy: req.user._id };
    allowed.forEach((f) => { if (req.body[f] !== undefined) data[f] = req.body[f]; });

    if (req.body.provider) {
      const prov = await Provider.findOne({ _id: req.body.provider, organization: req.orgId });
      if (!prov) return res.status(400).json({ success: false, message: 'Proveedor no válido.' });
    }

    if (req.files?.length) {
      data.attachments = req.files.map(f => ({
        url:      f.path,
        publicId: f.filename,
        filename: f.originalname,
        mimetype: f.mimetype,
        size:     f.size,
      }));
    }

    const expense = await Expense.create(data);
    await expense.populate('provider', 'name serviceType cuit');

    logger.info(`Gasto creado: ${expense.description} $${expense.amount} [org: ${req.orgId}]`);
    res.status(201).json({ success: true, data: { expense } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/expenses/:id ───────────────────────────────────
exports.updateExpense = async (req, res, next) => {
  try {
    const allowed = ['description', 'category', 'amount', 'date', 'provider', 'paymentMethod', 'expenseType', 'invoiceNumber', 'invoiceCuit'];
    const setFields = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) setFields[f] = req.body[f]; });

    if (req.body.provider) {
      const prov = await Provider.findOne({ _id: req.body.provider, organization: req.orgId });
      if (!prov) return res.status(400).json({ success: false, message: 'Proveedor no válido.' });
    }

    const updateQuery = { $set: setFields };

    if (req.files?.length) {
      const newAttachments = req.files.map(f => ({
        url:      f.path,
        publicId: f.filename,
        filename: f.originalname,
        mimetype: f.mimetype,
        size:     f.size,
      }));
      updateQuery.$push = { attachments: { $each: newAttachments } };
    }

    const expense = await Expense.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      updateQuery,
      { new: true, runValidators: true }
    ).populate('provider', 'name serviceType cuit');

    if (!expense) return res.status(404).json({ success: false, message: 'Gasto no encontrado.' });

    res.json({ success: true, data: { expense } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/expenses/:id/attachment/:index ───────────────────
exports.getAttachment = async (req, res, next) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, organization: req.orgId });
    if (!expense) return res.status(404).json({ success: false, message: 'Gasto no encontrado.' });

    const idx        = parseInt(req.params.index, 10);
    const attachment = expense.attachments?.[idx];
    if (!attachment?.publicId) {
      return res.status(404).json({ success: false, message: 'Adjunto no encontrado.' });
    }

    const mimetype     = attachment.mimetype || 'application/pdf';
    const isImage      = mimetype.startsWith('image/');
    const resourceType = isImage ? 'image' : 'raw';
    const ext          = isImage
      ? (mimetype.split('/')[1] === 'jpeg' ? 'jpg' : mimetype.split('/')[1])
      : 'pdf';
    const deliveryType = attachment.url?.includes('/authenticated/') ? 'authenticated' : 'upload';

    const signedUrl = cloudinary.utils.private_download_url(
      attachment.publicId,
      ext,
      {
        resource_type: resourceType,
        type:          deliveryType,
        expires_at:    Math.floor(Date.now() / 1000) + 120,
      }
    );

    const cloudRes = await fetch(signedUrl);
    if (!cloudRes.ok) {
      logger.error(`Cloudinary proxy error: ${cloudRes.status} — publicId: ${attachment.publicId}`);
      return res.status(502).json({ success: false, message: 'No se pudo obtener el adjunto desde Cloudinary.' });
    }

    const filename = (attachment.filename || `comprobante.${ext}`).replace(/"/g, '');
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${filename}"`);

    const contentLength = cloudRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    cloudRes.body.pipe(res);
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/expenses/:id/attachment/:index ────────────────
exports.deleteAttachment = async (req, res, next) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, organization: req.orgId });
    if (!expense) return res.status(404).json({ success: false, message: 'Gasto no encontrado.' });

    const idx        = parseInt(req.params.index, 10);
    const attachment = expense.attachments?.[idx];
    if (!attachment) return res.status(404).json({ success: false, message: 'Adjunto no encontrado.' });

    if (attachment.publicId) {
      const resType = attachment.mimetype?.startsWith('image/') ? 'image' : 'raw';
      await cloudinary.uploader.destroy(attachment.publicId, { resource_type: resType }).catch(() => {});
    }

    expense.attachments.splice(idx, 1);
    await expense.save();

    res.json({ success: true, message: 'Adjunto eliminado.' });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/expenses/:id/paid ──────────────────────────────
exports.markAsPaid = async (req, res, next) => {
  try {
    const { paymentMethod } = req.body;
    const expense = await Expense.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      { status: 'paid', ...(paymentMethod && { paymentMethod }) },
      { new: true }
    ).populate('provider', 'name serviceType cuit');

    if (!expense) return res.status(404).json({ success: false, message: 'Gasto no encontrado.' });

    logger.info(`Gasto marcado como pagado: ${expense.description} [org: ${req.orgId}]`);
    res.json({ success: true, data: { expense } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/expenses/:id ──────────────────────────────────
exports.deleteExpense = async (req, res, next) => {
  try {
    const expense = await Expense.findOneAndDelete({ _id: req.params.id, organization: req.orgId });
    if (!expense) return res.status(404).json({ success: false, message: 'Gasto no encontrado.' });

    for (const att of expense.attachments || []) {
      if (att.publicId) {
        const resType = att.mimetype?.startsWith('image/') ? 'image' : 'raw';
        await cloudinary.uploader.destroy(att.publicId, { resource_type: resType }).catch(() => {});
      }
    }

    logger.info(`Gasto eliminado: ${expense.description} [org: ${req.orgId}]`);
    res.json({ success: true, message: 'Gasto eliminado correctamente.' });
  } catch (err) {
    next(err);
  }
};
