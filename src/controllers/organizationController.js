const Organization        = require('../models/Organization');
const OrganizationFeature = require('../models/OrganizationFeature');
const User                = require('../models/User');
const logger              = require('../config/logger');

function currentYearPeriods() {
  const year = new Date().getFullYear();
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

// ── GET /api/organizations — listar (superadmin: todas; admin: la propia) ─
exports.getOrganizations = async (req, res, next) => {
  try {
    const filter = req.user.role === 'superadmin' ? {} : { _id: req.orgId };

    const orgs = await Organization.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: { organizations: orgs } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/organizations/:id — detalle ──────────────────────
exports.getOrganization = async (req, res, next) => {
  try {
    // Admin solo puede ver su propia org
    if (req.user.role === 'admin' && req.params.id !== req.orgId?.toString()) {
      return res.status(403).json({ success: false, message: 'No tenés permisos para ver esta organización.' });
    }

    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ success: false, message: 'Organización no encontrada.' });

    // Admin puede ver su mpPublicKey
    let data = org.toObject();
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      delete data.mpPublicKey;
    }
    delete data.mpAccessToken;
    delete data.mpWebhookSecret;

    res.json({ success: true, data: { organization: data } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/organizations/templates — listar templates disponibles ─
exports.getTemplates = (req, res) => {
  res.json({ success: true, data: { templates: Organization.listTemplates() } });
};

// ── POST /api/organizations — crear (admin o superadmin) ─────
exports.createOrganization = async (req, res, next) => {
  try {
    // Admin solo puede crear una organización si aún no tiene ninguna asignada
    if (req.user.role === 'admin' && req.orgId) {
      return res.status(403).json({
        success: false,
        message: 'Ya tenés una organización asignada. Contactá a un superadmin para crear una nueva.',
      });
    }

    const {
      template,
      name, slug, businessType,
      feeAmount, feePeriodCode, feePeriodLabel,
      lateFeePercent, dueDayOfMonth,
      feeLabel, memberLabel, unitLabel,
      address, adminEmail, adminPhone,
      mpPublicKey, mpAccessToken, mpWebhookSecret,
    } = req.body;

    // Resolver el tipo de negocio: si se pasó template úsalo, luego businessType, default consorcio
    const resolvedType = businessType || template || 'consorcio';

    // Cargar preset del template; los campos del body tienen prioridad
    const preset = Organization.getTemplate(resolvedType);

    const org = await Organization.create({
      name,
      slug:           slug || Organization.generateSlug(name),
      businessType:   resolvedType,
      feeAmount:      feeAmount      ?? preset.feeAmount,
      feePeriodCode:  feePeriodCode  ?? '',
      feePeriodLabel: feePeriodLabel ?? '',
      lateFeePercent: lateFeePercent ?? preset.lateFeePercent,
      dueDayOfMonth:  dueDayOfMonth  ?? preset.dueDayOfMonth,
      feeLabel:       feeLabel       || preset.feeLabel,
      memberLabel:    memberLabel    || preset.memberLabel,
      unitLabel:      unitLabel      || preset.unitLabel,
      address,
      adminEmail,
      adminPhone,
      mpPublicKey,
      mpAccessToken,
      mpWebhookSecret,
      paymentPeriods: currentYearPeriods(),
    });

    await OrganizationFeature.insertMany([
      { organization: org._id, featureKey: 'visits',       enabled: false },
      { organization: org._id, featureKey: 'reservations', enabled: false },
    ]);

    // Si el creador es admin, vincularlo a la nueva org automáticamente
    if (req.user.role === 'admin') {
      await User.findByIdAndUpdate(req.user._id, { organization: org._id });
      logger.info(`Admin ${req.user.email} vinculado a la nueva org "${org.name}" (${org._id})`);
    }

    logger.info(`Organización creada: "${org.name}" [${org.businessType}] (template: ${resolvedType}) por ${req.user.email}`);
    res.status(201).json({ success: true, data: { organization: org } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/organizations/:id — actualizar ─────────────────
exports.updateOrganization = async (req, res, next) => {
  try {
    // Admin solo puede editar su propia org
    if (req.user.role === 'admin' && req.params.id !== req.orgId?.toString()) {
      return res.status(403).json({ success: false, message: 'No tenés permisos para modificar esta organización.' });
    }

    const allowed = [
      'name', 'businessType', 'isActive',
      'feeAmount', 'feePeriodCode', 'feePeriodLabel',
      'lateFeePercent', 'dueDayOfMonth',
      'feeLabel', 'memberLabel', 'unitLabel',
      'address', 'adminEmail', 'adminPhone',
      'mpPublicKey', 'mpAccessToken', 'mpWebhookSecret',
    ];

    // Superadmin también puede cambiar el slug
    if (req.user.role === 'superadmin') allowed.push('slug');

    const update = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

    const org = await Organization.findByIdAndUpdate(req.params.id, update, {
      new: true, runValidators: true,
    });
    if (!org) return res.status(404).json({ success: false, message: 'Organización no encontrada.' });

    // No devolver credenciales sensibles
    const data = org.toObject();
    delete data.mpAccessToken;
    delete data.mpWebhookSecret;

    logger.info(`Organización actualizada: "${org.name}" por ${req.user.email}`);
    res.json({ success: true, data: { organization: data } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/organizations/:id — desactivar (superadmin) ───
exports.deleteOrganization = async (req, res, next) => {
  try {
    const org = await Organization.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    if (!org) return res.status(404).json({ success: false, message: 'Organización no encontrada.' });

    logger.info(`Organización desactivada: "${org.name}" por ${req.user.email}`);
    res.json({ success: true, message: 'Organización desactivada.' });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/organizations/:id/members — miembros de la org ───
exports.getMembers = async (req, res, next) => {
  try {
    if (req.user.role === 'admin' && req.params.id !== req.orgId?.toString()) {
      return res.status(403).json({ success: false, message: 'Acceso denegado.' });
    }

    const { role, isActive = 'true' } = req.query;
    const filter = { organization: req.params.id };
    if (role)     filter.role     = role;
    if (isActive) filter.isActive = isActive === 'true';

    const members = await User.find(filter).select('-__v').sort({ name: 1 });
    res.json({ success: true, data: { members } });
  } catch (err) {
    next(err);
  }
};
