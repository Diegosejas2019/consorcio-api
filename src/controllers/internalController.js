const Organization        = require('../models/Organization');
const OrganizationFeature = require('../models/OrganizationFeature');
const User                = require('../models/User');
const logger              = require('../config/logger');
const { sendAdminWelcome } = require('../services/emailService');

function currentYearPeriods() {
  const year = new Date().getFullYear();
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

// ── POST /api/internal/create-organization ────────────────────
exports.createOrganization = async (req, res, next) => {
  try {
    const { organizationName, businessType, adminName, email, password } = req.body;

    if (!organizationName || !adminName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Los campos organizationName, adminName, email y password son obligatorios.',
      });
    }

    const resolvedType = businessType || 'consorcio';
    const preset       = Organization.getTemplate(resolvedType);

    // Generar slug único: si ya existe, agregar sufijo numérico
    let baseSlug = Organization.generateSlug(organizationName);
    let slug     = baseSlug;
    let attempt  = 1;
    while (await Organization.exists({ slug })) {
      slug = `${baseSlug}-${attempt++}`;
    }

    const org = await Organization.create({
      name:           organizationName,
      slug,
      businessType:   resolvedType,
      feeAmount:      preset.feeAmount,
      lateFeePercent: preset.lateFeePercent,
      dueDayOfMonth:  preset.dueDayOfMonth,
      feeLabel:       preset.feeLabel,
      memberLabel:    preset.memberLabel,
      unitLabel:      preset.unitLabel,
      paymentPeriods: currentYearPeriods(),
    });

    await OrganizationFeature.insertMany([
      { organization: org._id, featureKey: 'visits',       enabled: false },
      { organization: org._id, featureKey: 'reservations', enabled: false },
    ]);

    const admin = await User.create({
      name:         adminName,
      email,
      password,
      role:         'admin',
      organization: org._id,
    });

    // Nunca devolver el password
    const adminData = admin.toObject();
    delete adminData.password;

    logger.info(`[internal] Organización "${org.name}" creada con admin ${email}`);

    sendAdminWelcome(adminData, password, org.name).catch((err) =>
      logger.error(`Error enviando email de bienvenida al admin ${email}: ${err.message}`)
    );

    res.status(201).json({
      success: true,
      data: {
        organization: org,
        admin:        adminData,
      },
    });
  } catch (err) {
    next(err);
  }
};
