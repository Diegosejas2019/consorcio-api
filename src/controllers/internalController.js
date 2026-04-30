const Organization        = require('../models/Organization');
const OrganizationFeature = require('../models/OrganizationFeature');
const OrganizationMember  = require('../models/OrganizationMember');
const User                = require('../models/User');
const logger              = require('../config/logger');
const { sendAdminWelcome } = require('../services/emailService');
const { defaultFeatureRecords } = require('../utils/features');

function currentYearPeriods() {
  const year = new Date().getFullYear();
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

// ── POST /api/internal/create-organization ────────────────────
exports.createOrganization = async (req, res, next) => {
  try {
    const { organizationName, businessType, adminName, email, password } = req.body;

    if (!organizationName || !adminName || !email) {
      return res.status(400).json({
        success: false,
        message: 'Los campos organizationName, adminName y email son obligatorios.',
      });
    }

    // Determinar si el usuario ya existe
    const existingUser = await User.findOne({ email: email.toLowerCase() });

    if (!existingUser && !password) {
      return res.status(400).json({
        success: false,
        message: 'El campo password es obligatorio para nuevos administradores.',
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

    await OrganizationFeature.insertMany(defaultFeatureRecords(org._id));

    let admin;
    let isNewUser = false;

    if (!existingUser) {
      admin = await User.create({
        name:  adminName,
        email,
        password,
        role:  'admin',
      });
      isNewUser = true;
    } else {
      // Verificar que no sea ya admin de esta organización
      const duplicate = await OrganizationMember.findOne({
        user:         existingUser._id,
        organization: org._id,
        role:         'admin',
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: 'El usuario ya es administrador de esta organización.',
        });
      }
      admin = existingUser;
    }

    await OrganizationMember.create({
      user:         admin._id,
      organization: org._id,
      role:         'admin',
    });

    const adminData = admin.toObject();
    delete adminData.password;

    logger.info(`[internal] Organización "${org.name}" creada con admin ${email} (usuario ${isNewUser ? 'nuevo' : 'existente'})`);

    if (isNewUser) {
      sendAdminWelcome(adminData, password, org.name).catch((err) =>
        logger.error(`Error enviando email de bienvenida al admin ${email}: ${err.message}`)
      );
    }

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
