const {
  createDebtReminder,
  exportDelinquencyCsv,
  getDebtAgingBuckets,
  getDelinquentOwners,
  getOwnerDebtDetail,
  getOrganizationDelinquencySummary,
} = require('../services/delinquencyService');

exports.getSummary = async (req, res, next) => {
  try {
    const summary = await getOrganizationDelinquencySummary(req.orgId, req.query);
    res.json({ success: true, data: { summary } });
  } catch (err) {
    next(err);
  }
};

exports.getOwners = async (req, res, next) => {
  try {
    const result = await getDelinquentOwners(req.orgId, req.query);
    res.json({
      success: true,
      data: { owners: result.owners, filters: result.filters },
      pagination: result.pagination,
    });
  } catch (err) {
    next(err);
  }
};

exports.getOwnerDetail = async (req, res, next) => {
  try {
    const detail = await getOwnerDebtDetail(req.orgId, req.params.ownerId);
    if (!detail) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    res.json({ success: true, data: { detail } });
  } catch (err) {
    next(err);
  }
};

exports.getAging = async (req, res, next) => {
  try {
    const buckets = await getDebtAgingBuckets(req.orgId, req.query);
    res.json({ success: true, data: { buckets } });
  } catch (err) {
    next(err);
  }
};

exports.createReminder = async (req, res, next) => {
  try {
    const result = await createDebtReminder({
      organizationId: req.orgId,
      ownerId: req.params.ownerId,
      userId: req.user._id,
      channel: req.body.channel,
      message: req.body.message,
    });
    if (!result) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    res.status(201).json({
      success: true,
      message: result.notice ? 'Recordatorio enviado por comunicado interno.' : 'Recordatorio registrado.',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

exports.exportOwners = async (req, res, next) => {
  try {
    const csv = await exportDelinquencyCsv(req.orgId, req.query);
    const filename = `morosidad_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    next(err);
  }
};

exports.exportOwner = async (req, res, next) => {
  try {
    const detail = await getOwnerDebtDetail(req.orgId, req.params.ownerId);
    if (!detail) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    const csv = await exportDelinquencyCsv(req.orgId, req.query, req.params.ownerId);
    const filename = `deuda_${String(detail.owner.name || 'propietario').replace(/[^\w-]+/g, '_')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    next(err);
  }
};
