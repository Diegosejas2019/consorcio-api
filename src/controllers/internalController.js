const Organization = require('../models/Organization');
const User         = require('../models/User');
const logger       = require('../config/logger');

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
      name:          organizationName,
      slug,
      businessType:  resolvedType,
      feeAmount:     preset.feeAmount,
      lateFeePercent: preset.lateFeePercent,
      dueDayOfMonth: preset.dueDayOfMonth,
      feeLabel:      preset.feeLabel,
      memberLabel:   preset.memberLabel,
      unitLabel:     preset.unitLabel,
    });

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
