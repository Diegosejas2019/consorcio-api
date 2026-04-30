const OrganizationFeature = require('../models/OrganizationFeature');
const logger              = require('../config/logger');
const { isSuperAdminRole } = require('../utils/roles');

const KNOWN_FEATURES = ['visits', 'reservations', 'votes', 'expenses', 'providers'];

// ── GET /api/organizations/:id/features ───────────────────────
exports.getFeatures = async (req, res, next) => {
  try {
    const orgId = req.params.id;

    // Verificar que el usuario pertenece a esta org (o es superadmin)
    if (!isSuperAdminRole(req.user.role) && req.orgId?.toString() !== orgId) {
      return res.status(403).json({ success: false, message: 'No tenés permisos para ver estas configuraciones.' });
    }

    const records = await OrganizationFeature.find({ organization: orgId });

    // Construir objeto con defaults en true para features no configuradas
    const features = {};
    KNOWN_FEATURES.forEach(key => { features[key] = true; });
    records.forEach(r => { features[r.featureKey] = r.enabled; });

    res.json({ success: true, data: { features } });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/organizations/:id/features ───────────────────────
exports.updateFeatures = async (req, res, next) => {
  try {
    const orgId = req.params.id;

    // Admin solo puede modificar su propia org
    if (req.user.role === 'admin' && req.orgId?.toString() !== orgId) {
      return res.status(403).json({ success: false, message: 'No tenés permisos para modificar estas configuraciones.' });
    }

    const updates = req.body;

    // Solo procesar keys conocidas
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
    const records = await OrganizationFeature.find({ organization: orgId });
    const features = {};
    KNOWN_FEATURES.forEach(key => { features[key] = true; });
    records.forEach(r => { features[r.featureKey] = r.enabled; });

    logger.info(`Features actualizadas para org ${orgId} por ${req.user.email}`);
    res.json({ success: true, data: { features } });
  } catch (err) {
    next(err);
  }
};
