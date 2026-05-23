const renditionService = require('../services/renditionService');
const logger           = require('../config/logger');

const PERIOD_RE = /^\d{4}-\d{2}$/;
const YEAR_RE   = /^\d{4}$/;

// GET /api/renditions/preview?period=YYYY-MM
exports.getPreview = async (req, res, next) => {
  try {
    const { period } = req.query;
    if (!period || !PERIOD_RE.test(period)) {
      return res.status(400).json({ success: false, message: 'Parámetro period inválido. Formato: YYYY-MM' });
    }
    const data = await renditionService.buildRenditionPreview(req.orgId, period);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /api/renditions/history
exports.getHistory = async (req, res, next) => {
  try {
    const history = await renditionService.getRenditionHistory(req.orgId);
    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
};

// POST /api/renditions/:period/generate-pdf
exports.generatePdf = async (req, res, next) => {
  try {
    const { period } = req.params;
    if (!PERIOD_RE.test(period)) {
      return res.status(400).json({ success: false, message: 'Período inválido. Formato: YYYY-MM' });
    }
    logger.info(`[renditionController] generatePdf org=${req.orgId} period=${period} by=${req.user?._id}`);
    const result = await renditionService.generateEnhancedPdf(req.orgId, period, req.user?._id);
    res.json({ success: true, data: { pdfUrl: result.pdfUrl, rendition: result.rendition } });
  } catch (err) {
    next(err);
  }
};

// GET /api/renditions/:period/export-csv?section=resumen|gastos|pagos|morosidad
exports.exportCsv = async (req, res, next) => {
  try {
    const { period } = req.params;
    const { section = 'resumen' } = req.query;
    if (!PERIOD_RE.test(period)) {
      return res.status(400).json({ success: false, message: 'Período inválido. Formato: YYYY-MM' });
    }
    const validSections = ['resumen', 'gastos', 'pagos', 'morosidad'];
    if (!validSections.includes(section)) {
      return res.status(400).json({ success: false, message: `Sección inválida. Opciones: ${validSections.join(', ')}` });
    }
    const csv = await renditionService.exportRenditionCsv(req.orgId, period, section);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rendicion_${period}_${section}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

// PATCH /api/renditions/:period/observations
exports.saveObservations = async (req, res, next) => {
  try {
    const { period } = req.params;
    const { observations } = req.body;
    if (!PERIOD_RE.test(period)) {
      return res.status(400).json({ success: false, message: 'Período inválido. Formato: YYYY-MM' });
    }
    if (typeof observations !== 'string') {
      return res.status(400).json({ success: false, message: 'Campo observations requerido.' });
    }
    const doc = await renditionService.saveObservations(req.orgId, period, observations, req.user?._id);
    res.json({ success: true, data: { observations: doc.observations } });
  } catch (err) {
    next(err);
  }
};

// GET /api/renditions/annual?year=YYYY
exports.getAnnual = async (req, res, next) => {
  try {
    const { year } = req.query;
    if (!year || !YEAR_RE.test(year)) {
      return res.status(400).json({ success: false, message: 'Parámetro year inválido. Formato: YYYY' });
    }
    const data = await renditionService.buildAnnualRendition(req.orgId, year);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
