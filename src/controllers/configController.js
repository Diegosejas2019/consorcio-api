const Organization = require('../models/Organization');

/**
 * Mapea los campos de Organization a los nombres que espera el frontend,
 * manteniendo compatibilidad con la API existente.
 */
function orgToConfigView(org, includePublicKey = false) {
  const data = {
    _id: org._id,
    // ── Aliases de compatibilidad ──
    expenseAmount:    org.feeAmount,
    expenseMonth:     org.feePeriodLabel,
    expenseMonthCode: org.feePeriodCode,
    lateFeePercent:   org.lateFeePercent,
    dueDayOfMonth:    org.dueDayOfMonth,
    consortiumName:   org.name,
    consortiumAddress: org.address,
    adminEmail:       org.adminEmail,
    adminPhone:       org.adminPhone,
    // ── Nuevos campos ──
    feeLabel:     org.feeLabel,
    memberLabel:  org.memberLabel,
    unitLabel:    org.unitLabel,
    businessType: org.businessType,
    slug:         org.slug,
    orgId:        org._id,
  };
  if (includePublicKey) data.mpPublicKey = org.mpPublicKey;
  return data;
}

// Mapea los nombres legacy del frontend a los campos reales del modelo
const FIELD_MAP = {
  expenseAmount:     'feeAmount',
  expenseMonth:      'feePeriodLabel',
  expenseMonthCode:  'feePeriodCode',
  lateFeePercent:    'lateFeePercent',
  dueDayOfMonth:     'dueDayOfMonth',
  consortiumName:    'name',
  consortiumAddress: 'address',
  adminEmail:        'adminEmail',
  adminPhone:        'adminPhone',
  mpPublicKey:       'mpPublicKey',
  mpAccessToken:     'mpAccessToken',
  mpWebhookSecret:   'mpWebhookSecret',
  // Nuevos campos (nombre directo)
  feeLabel:    'feeLabel',
  memberLabel: 'memberLabel',
  unitLabel:   'unitLabel',
  businessType: 'businessType',
};

// ── GET /api/config ───────────────────────────────────────────
exports.getConfig = async (req, res, next) => {
  try {
    // Admin con org poblada en req.org (lo pone protect)
    const org = req.org
      ? await Organization.findById(req.org._id).select('+mpPublicKey')
      : null;

    if (!org) {
      return res.status(404).json({ success: false, message: 'Organización no configurada.' });
    }

    const isAdmin = req.user?.role === 'admin' || req.user?.role === 'superadmin';
    res.json({ success: true, data: { config: orgToConfigView(org, isAdmin) } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/config ─────────────────────────────────────────
exports.updateConfig = async (req, res, next) => {
  try {
    if (!req.orgId) {
      return res.status(400).json({ success: false, message: 'Organización requerida.' });
    }

    const update = {};
    Object.entries(FIELD_MAP).forEach(([legacyKey, orgKey]) => {
      if (req.body[legacyKey] !== undefined) update[orgKey] = req.body[legacyKey];
    });

    const org = await Organization.findByIdAndUpdate(
      req.orgId,
      update,
      { new: true, runValidators: true }
    ).select('+mpPublicKey');

    if (!org) return res.status(404).json({ success: false, message: 'Organización no encontrada.' });

    res.json({ success: true, data: { config: orgToConfigView(org, true) } });
  } catch (err) {
    next(err);
  }
};
