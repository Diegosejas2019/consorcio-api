const PayrollRuleVersion = require('../models/PayrollRuleVersion');
const logger = require('../config/logger');

// GET /api/payroll/rules — lista todas las versiones (superadmin)
exports.listVersions = async (req, res, next) => {
  try {
    const versions = await PayrollRuleVersion.find({ country: 'AR' }).sort({ effectiveFrom: -1 }).select('-__v');
    res.json({ success: true, data: { versions } });
  } catch (err) {
    next(err);
  }
};

// GET /api/payroll/rules/:version — detalle de una versión
exports.getVersion = async (req, res, next) => {
  try {
    const version = await PayrollRuleVersion.findOne({ version: req.params.version }).select('-__v');
    if (!version) return res.status(404).json({ success: false, message: 'Versión de reglas no encontrada.' });
    res.json({ success: true, data: { version } });
  } catch (err) {
    next(err);
  }
};

// POST /api/payroll/rules — crear nueva versión (superadmin)
exports.createVersion = async (req, res, next) => {
  try {
    const { version, effectiveFrom, effectiveTo, rules, source, notes } = req.body;
    if (!version || !effectiveFrom || !rules) {
      return res.status(400).json({ success: false, message: 'version, effectiveFrom y rules son obligatorios.' });
    }

    const record = await PayrollRuleVersion.create({
      version, country: 'AR', effectiveFrom, effectiveTo, rules, source, notes,
      createdBy: req.user._id,
    });

    logger.info(`PayrollRuleVersion creada: ${version} [usuario: ${req.user._id}]`);
    res.status(201).json({ success: true, data: { version: record } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Ya existe una versión con ese identificador.' });
    }
    next(err);
  }
};
