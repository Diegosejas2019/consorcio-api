const Organization = require('../models/Organization');
const { isSuperAdminRole } = require('../utils/roles');

// ── Helpers de recargo ────────────────────────────────────────
/**
 * Devuelve true si hoy es posterior al día de vencimiento del período actual.
 * El recargo aplica a partir del día siguiente al vencimiento.
 */
function computeIsOverdue(org) {
  if (!org.feePeriodCode || !org.dueDayOfMonth) return false;
  const [year, month] = org.feePeriodCode.split('-').map(Number);
  const dueDate = new Date(year, month - 1, org.dueDayOfMonth, 23, 59, 59, 999);
  return new Date() > dueDate;
}

function computeSurcharge(org) {
  if (!computeIsOverdue(org)) return 0;
  if (org.lateFeeType === 'fixed') return org.lateFeeFixed || 0;
  const base = org.monthlyFee || org.feeAmount || 0;
  return Math.round(base * (org.lateFeePercent || 0) / 100);
}

/**
 * Mapea los campos de Organization a los nombres que espera el frontend,
 * manteniendo compatibilidad con la API existente.
 */
function orgToConfigView(org, includePublicKey = false) {
  const surcharge = computeSurcharge(org);
  const data = {
    hasMercadoPago: !!org.mpAccessToken,
    _id: org._id,
    // ── Monto mensual ──
    monthlyFee:       org.monthlyFee || 0,
    // ── Aliases de compatibilidad ──
    expenseAmount:    org.feeAmount,
    expenseMonth:     org.feePeriodLabel,
    expenseMonthCode: org.feePeriodCode,
    paymentPeriods:   org.paymentPeriods,
    lateFeeType:      org.lateFeeType,
    lateFeePercent:   org.lateFeePercent,
    lateFeeFixed:     org.lateFeeFixed,
    dueDayOfMonth:    org.dueDayOfMonth,
    consortiumName:   org.name,
    consortiumAddress: org.address,
    consortiumCuit:   org.cuit,
    adminEmail:       org.adminEmail,
    adminPhone:       org.adminPhone,
    bankName:         org.bankName,
    bankAccount:      org.bankAccount,
    bankCbu:          org.bankCbu,
    bankHolder:       org.bankHolder,
    // ── Recargo calculado ──
    isOverdue:  computeIsOverdue(org),
    surcharge,
    totalDue:   (org.monthlyFee || org.feeAmount || 0) + surcharge,
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
exports.orgToConfigView = orgToConfigView;

// Mapea los nombres legacy del frontend a los campos reales del modelo
const FIELD_MAP = {
  expenseAmount:     'feeAmount',
  expenseMonth:      'feePeriodLabel',
  expenseMonthCode:  'feePeriodCode',
  paymentPeriods:    'paymentPeriods',
  lateFeeType:       'lateFeeType',
  lateFeePercent:    'lateFeePercent',
  lateFeeFixed:      'lateFeeFixed',
  dueDayOfMonth:     'dueDayOfMonth',
  consortiumName:    'name',
  consortiumAddress: 'address',
  consortiumCuit:    'cuit',
  adminEmail:        'adminEmail',
  adminPhone:        'adminPhone',
  mpPublicKey:       'mpPublicKey',
  mpAccessToken:     'mpAccessToken',
  mpWebhookSecret:   'mpWebhookSecret',
  // Nuevos campos (nombre directo)
  monthlyFee:   'monthlyFee',
  feeLabel:     'feeLabel',
  memberLabel:  'memberLabel',
  unitLabel:    'unitLabel',
  businessType: 'businessType',
  bankName:     'bankName',
  bankAccount:  'bankAccount',
  bankCbu:      'bankCbu',
  bankHolder:   'bankHolder',
};

// ── GET /api/config ───────────────────────────────────────────
exports.getConfig = async (req, res, next) => {
  try {
    const org = req.org
      ? await Organization.findById(req.org._id).select('+mpPublicKey +mpAccessToken')
      : null;

    if (!org) {
      return res.status(404).json({ success: false, message: 'Organización no configurada.' });
    }

    const isAdmin = req.user?.role === 'admin' || isSuperAdminRole(req.user?.role);
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
