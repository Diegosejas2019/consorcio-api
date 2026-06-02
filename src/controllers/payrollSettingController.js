const PayrollSetting = require('../models/PayrollSetting');
const logger = require('../config/logger');

// GET /api/payroll/settings
exports.getSettings = async (req, res, next) => {
  try {
    const setting = await PayrollSetting.findOne({ organization: req.orgId }).select('-__v');
    if (!setting) {
      return res.status(404).json({ success: false, message: 'No hay configuración de empleador registrada para esta organización.' });
    }
    res.json({ success: true, data: { payrollSetting: setting } });
  } catch (err) {
    next(err);
  }
};

// PUT /api/payroll/settings
exports.upsertSettings = async (req, res, next) => {
  try {
    const allowed = ['employerLegalName', 'employerCuit', 'employerAddress', 'employerActivity', 'defaultConvention', 'defaultPaymentMethod', 'active'];
    const data = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) data[f] = req.body[f]; });

    if (!data.employerLegalName && !await PayrollSetting.exists({ organization: req.orgId })) {
      return res.status(400).json({ success: false, message: 'La razón social del empleador es obligatoria.' });
    }

    const setting = await PayrollSetting.findOneAndUpdate(
      { organization: req.orgId },
      { ...data, updatedBy: req.user._id, $setOnInsert: { organization: req.orgId, createdBy: req.user._id } },
      { new: true, upsert: true, runValidators: true, select: '-__v' }
    );

    logger.info(`PayrollSetting upserted [org: ${req.orgId}]`);
    res.json({ success: true, data: { payrollSetting: setting } });
  } catch (err) {
    next(err);
  }
};
