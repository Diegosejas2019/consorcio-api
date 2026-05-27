const OrganizationFeature = require('../models/OrganizationFeature');
const { buildDefaultFeatureMap } = require('../utils/features');

function requireFeature(featureKey) {
  return async (req, res, next) => {
    if (!req.orgId) return next();
    const records = await OrganizationFeature.find({ organization: req.orgId, featureKey }).lean();
    const features = buildDefaultFeatureMap(records);
    if (!features[featureKey]) {
      return res.status(403).json({ success: false, message: 'Esta función no está habilitada para tu organización.' });
    }
    next();
  };
}

module.exports = { requireFeature };
