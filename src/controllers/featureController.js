const OrganizationFeature = require('../models/OrganizationFeature');
const Organization        = require('../models/Organization');
const logger              = require('../config/logger');
const { isSuperAdminRole } = require('../utils/roles');
const { KNOWN_FEATURES, buildDefaultFeatureMap } = require('../utils/features');

async function buildFeaturesResponse(orgId, records = null, org = null) {
  const [featureRecords, organization] = await Promise.all([
    records ? Promise.resolve(records) : OrganizationFeature.find({ organization: orgId }),
    org ? Promise.resolve(org) : Organization.findById(orgId).select('paymentPlansEnabled paymentPlansAllowOwnerRequests').lean(),
  ]);

  const features = buildDefaultFeatureMap(featureRecords);
  const plansEnabled = organization ? organization.paymentPlansEnabled !== false : true;
  features['paymentPlans'] = plansEnabled;
  features['paymentPlans.allowOwnerRequests'] = plansEnabled && (organization ? organization.paymentPlansAllowOwnerRequests !== false : true);

  return features;
}

// ── GET /api/organizations/:id/features ───────────────────────
exports.getFeatures = async (req, res, next) => {
  try {
    const orgId = req.params.id;

    // Verificar que el usuario pertenece a esta org (o es superadmin)
    if (!isSuperAdminRole(req.user.role) && req.orgId?.toString() !== orgId) {
      return res.status(403).json({ success: false, message: 'No tenés permisos para ver estas configuraciones.' });
    }

    const features = await buildFeaturesResponse(orgId);

    res.json({ success: true, data: { features } });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/organizations/:id/features ───────────────────────
exports.updateFeatures = async (req, res, next) => {
  try {
    const orgId = req.params.id;

    if (!isSuperAdminRole(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Solo un SuperAdmin puede modificar modulos de una organizacion.' });
    }

    const updates = req.body;

    const orgUpdate = {};
    if (Object.prototype.hasOwnProperty.call(updates, 'paymentPlans')) {
      orgUpdate.paymentPlansEnabled = !!updates.paymentPlans;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'paymentPlans.allowOwnerRequests')) {
      orgUpdate.paymentPlansAllowOwnerRequests = !!updates['paymentPlans.allowOwnerRequests'];
    }

    if (Object.keys(orgUpdate).length) {
      await Organization.findByIdAndUpdate(orgId, orgUpdate, { runValidators: true });
    }

    // Solo procesar keys conocidas persistidas en OrganizationFeature
    const ops = Object.entries(updates)
      .filter(([key]) => KNOWN_FEATURES.includes(key))
      .map(([key, enabled]) =>
        OrganizationFeature.findOneAndUpdate(
          { organization: orgId, featureKey: key },
          { enabled: !!enabled },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        )
      );

    await Promise.all(ops);

    // Retornar estado actualizado
    const features = await buildFeaturesResponse(orgId);

    logger.info(`Features actualizadas para org ${orgId} por ${req.user.email}`);
    res.json({ success: true, data: { features } });
  } catch (err) {
    next(err);
  }
};
