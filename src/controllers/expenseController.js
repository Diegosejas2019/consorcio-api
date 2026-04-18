const Expense  = require('../models/Expense');
const Provider = require('../models/Provider');
const logger   = require('../config/logger');
const { cloudinary } = require('../config/cloudinary');

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
        .populate('provider', 'name serviceType')
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
    const allowed = ['description', 'category', 'amount', 'date', 'provider', 'paymentMethod'];
    const data    = { organization: req.orgId, createdBy: req.user._id };
    allowed.forEach((f) => { if (req.body[f] !== undefined) data[f] = req.body[f]; });

    if (req.body.provider) {
      const prov = await Provider.findOne({ _id: req.body.provider, organization: req.orgId });
      if (!prov) return res.status(400).json({ success: false, message: 'Proveedor no válido.' });
    }

    if (req.file) {
      data.receipt = { url: req.file.path, publicId: req.file.filename };
    }

    const expense = await Expense.create(data);
    await expense.populate('provider', 'name serviceType');

    logger.info(`Gasto creado: ${expense.description} $${expense.amount} [org: ${req.orgId}]`);
    res.status(201).json({ success: true, data: { expense } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/expenses/:id ───────────────────────────────────
exports.updateExpense = async (req, res, next) => {
  try {
    const allowed = ['description', 'category', 'amount', 'date', 'provider', 'paymentMethod'];
    const update  = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

    if (req.body.provider) {
      const prov = await Provider.findOne({ _id: req.body.provider, organization: req.orgId });
      if (!prov) return res.status(400).json({ success: false, message: 'Proveedor no válido.' });
    }

    const expense = await Expense.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      update,
      { new: true, runValidators: true }
    ).populate('provider', 'name serviceType');

    if (!expense) return res.status(404).json({ success: false, message: 'Gasto no encontrado.' });

    res.json({ success: true, data: { expense } });
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
    ).populate('provider', 'name serviceType');

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

    if (expense.receipt?.publicId) {
      await cloudinary.uploader.destroy(expense.receipt.publicId, { resource_type: 'raw' }).catch(() => {});
    }

    logger.info(`Gasto eliminado: ${expense.description} [org: ${req.orgId}]`);
    res.json({ success: true, message: 'Gasto eliminado correctamente.' });
  } catch (err) {
    next(err);
  }
};
