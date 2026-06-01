const crypto             = require('crypto');
const User               = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Organization = require('../models/Organization');
const Payment       = require('../models/Payment');
const PaymentPlan   = require('../models/PaymentPlan');
const OwnerDebtItem = require('../models/OwnerDebtItem');
const Unit    = require('../models/Unit');
const Notice  = require('../models/Notice');
const logger    = require('../config/logger');
const puppeteer = require('puppeteer');
const { sendToUser } = require('../services/firebaseService');
const { sendWelcome, sendEmailChangeConfirmation } = require('../services/emailService');
const { formatYYYYMM, getNextMonth } = require('../utils/periods');
const { orgToConfigView } = require('./configController');
const { buildAvailablePaymentItems } = require('./paymentController');
const {
  getOwnerDebtOptions,
  getPlanSummariesByOwner,
} = require('../services/paymentPlanDebtService');
const { trackUsageEvent } = require('../services/platformUsageService');
const { calcUnitFee } = require('./unitController');
const { withIsRead } = require('./noticeController');
const { buildVisibleFilterForOwner } = require('../services/communicationService');
const {
  computeTotalOwedByUnits,
  computeUnitsBalance,
  computeUnitsBalanceOwed,
  normalizeDebtBalance,
  summarizeUnitDebts,
  calculateUnitFee,
  getUnpaidPeriodsForUnit,
  isUnitChargeableForPeriod,
} = require('../utils/ownerFinance');
const XLSX    = require('xlsx');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function argentinaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function dayOrdinal({ year, month, day }) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function nowForCalculations() {
  const override = process.env.GESTIONAR_CURRENT_DATE_OVERRIDE;
  if (override && !Number.isNaN(new Date(override).getTime())) return new Date(override);
  return new Date();
}

function dueInfoForPeriod(period, org, now = nowForCalculations()) {
  if (!PERIOD_RE.test(period || '') || !org?.dueDayOfMonth) {
    return { daysOverdue: 0, isOverdue: false };
  }
  const [year, month] = period.split('-').map(Number);
  const day = Math.min(Math.max(Number(org.dueDayOfMonth || 10), 1), 28);
  const daysOverdue = Math.max(0, dayOrdinal(argentinaParts(now)) - dayOrdinal({ year, month, day }));
  return { daysOverdue, isOverdue: daysOverdue > 0 };
}

function clampLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

// Campos del User que son identidad global (no datos financieros por org)
const USER_FIELDS = new Set(['name', 'email', 'password', 'unit', 'unitId', 'phone', 'phones', 'role', 'organization', 'createdBy', 'isActive']);
const EXISTING_USER_FIELDS = new Set(['name', 'unit', 'unitId', 'phone', 'phones', 'isActive']);

function normalizeUnitName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function getRequestedUnitIds(body) {
  const values = [];
  if (body.unitIds !== undefined) {
    values.push(...(Array.isArray(body.unitIds) ? body.unitIds : [body.unitIds]));
  }
  if (body.unitId !== undefined && body.unitId !== null && body.unitId !== '') {
    values.push(body.unitId);
  }
  return [...new Set(values.map(id => String(id)).filter(Boolean))];
}

function normalizeUnitBillingSettings(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let values = raw;
  if (typeof raw === 'string') {
    try {
      values = JSON.parse(raw);
    } catch {
      values = [];
    }
  }
  if (!Array.isArray(values)) values = [values];

  return values.map(item => ({
    unitId: String(item.unitId || item.id || item._id || '').trim(),
    collectionStartPeriod: String(item.collectionStartPeriod || item.startBillingPeriod || '').trim(),
    initialDebt: item.initialDebt ?? item.previousBalance ?? item.balance ?? 0,
  })).filter(item => item.unitId);
}

function validateUnitBillingSettings(settings = []) {
  for (const setting of settings) {
    if (setting.collectionStartPeriod && !PERIOD_RE.test(setting.collectionStartPeriod)) {
      return 'El inicio de cobro debe tener formato YYYY-MM.';
    }
    const initialDebt = Number(setting.initialDebt || 0);
    if (!Number.isFinite(initialDebt) || initialDebt < 0) {
      return 'La deuda inicial de la unidad no puede ser negativa.';
    }
  }
  return null;
}

async function applyUnitBillingSettings(units = [], settings = [], fallbackStartBillingPeriod) {
  if (!units.length) return;
  const settingsByUnit = new Map(settings.map(setting => [setting.unitId, setting]));
  const updates = units.map(unit => {
    const unitId = unit._id.toString();
    const setting = settingsByUnit.get(unitId);
    const update = {};

    if (setting) {
      update.startBillingPeriod = setting.collectionStartPeriod || undefined;
      const balance = normalizeDebtBalance(Number(setting.initialDebt || 0));
      update.balance = balance;
      update.isDebtor = balance < 0;
    } else if (fallbackStartBillingPeriod && !unit.startBillingPeriod) {
      update.startBillingPeriod = fallbackStartBillingPeriod;
    }

    if (!Object.keys(update).length) return null;
    return Unit.updateOne({ _id: unit._id }, { $set: update });
  }).filter(Boolean);

  await Promise.all(updates);
}

function normalizePhonesInput(body) {
  const values = [];

  if (body.phones !== undefined) {
    values.push(...(Array.isArray(body.phones) ? body.phones : [body.phones]));
  }
  if (body.phone !== undefined) values.push(body.phone);

  const phones = [...new Set(values
    .flatMap(value => String(value || '').split(/[,;\n]/))
    .map(value => value.trim())
    .filter(Boolean))];
  if (!phones.length && (body.phones !== undefined || body.phone !== undefined)) return { phone: undefined, phones: [] };
  if (!phones.length) return {};

  return { phone: phones[0], phones };
}

async function findAssignableUnits(unitIds, orgId, ownerId) {
  if (!unitIds.length) return { units: [] };

  const units = await Unit.find({
    _id: { $in: unitIds },
    organization: orgId,
    active: true,
  });
  const foundIds = new Set(units.map(u => u._id.toString()));
  const missing = unitIds.find(id => !foundIds.has(id));
  if (missing) return { error: { status: 404, message: 'Unidad no encontrada.' } };

  const occupied = units.find(unit => unit.owner && (!ownerId || unit.owner.toString() !== ownerId.toString()));
  if (occupied) {
    return { error: { status: 400, message: `La unidad ${occupied.name} ya estÃ¡ ocupada.` } };
  }

  return { units };
}

async function syncOwnerUnits(ownerId, orgId, requestedUnitIds) {
  const { units, error } = await findAssignableUnits(requestedUnitIds, orgId, ownerId);
  if (error) return { error };

  const requestedSet = new Set(requestedUnitIds);
  const currentUnits = await Unit.find({ owner: ownerId, organization: orgId, active: true }).select('_id');
  const releaseIds = currentUnits
    .map(u => u._id)
    .filter(id => !requestedSet.has(id.toString()));

  await Promise.all([
    releaseIds.length
      ? Unit.updateMany({ _id: { $in: releaseIds } }, { owner: null, status: 'available' })
      : Promise.resolve(),
    requestedUnitIds.length
      ? Unit.updateMany({ _id: { $in: requestedUnitIds } }, { owner: ownerId, status: 'occupied' })
      : Promise.resolve(),
    User.findByIdAndUpdate(ownerId, { unitId: requestedUnitIds[0] || null }),
  ]);

  return { units };
}

async function setOwnerUnitBalance(ownerId, orgId, rawBalance) {
  const balance = normalizeDebtBalance(rawBalance);
  const units = await Unit.find({ owner: ownerId, organization: orgId, active: true }).select('_id name');
  if (units.length !== 1) {
    return {
      error: {
        status: 400,
        message: 'La deuda debe asignarse a una única unidad. Revisá las unidades del propietario.',
      },
    };
  }

  await Unit.findByIdAndUpdate(units[0]._id, {
    balance,
    isDebtor: balance < 0,
  });
  return { unit: units[0], balance };
}

async function distributeInitialDebt(units, rawAmount) {
  const amount = Number(rawAmount || 0);
  if (amount <= 0 || !units.length) return;

  const debtPerUnit = normalizeDebtBalance(amount / units.length);
  await Unit.updateMany(
    { _id: { $in: units.map(unit => unit._id) } },
    {
      balance: debtPerUnit,
      isDebtor: true,
    }
  );
}

async function validateLegacyUnitAvailable(orgId, unitName, ownerId = null) {
  const normalized = normalizeUnitName(unitName);
  if (!normalized) return null;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const memberships = await OrganizationMember.find({ organization: orgId, role: 'owner', isActive: true })
    .select('user')
    .lean();
  const ownerIds = memberships.map(m => m.user).filter(id => !ownerId || id.toString() !== ownerId.toString());

  const legacyOwner = ownerIds.length
    ? await User.findOne({
        _id: { $in: ownerIds },
        role: 'owner',
        isActive: true,
        unit: { $regex: `^${escaped}$`, $options: 'i' },
      }).select('_id unit')
    : null;
  if (legacyOwner) return legacyOwner.unit || normalized;

  const existingUnit = await Unit.findOne({
    organization: orgId,
    active: true,
    name: { $regex: `^${escaped}$`, $options: 'i' },
    owner: { $ne: ownerId || null },
  }).select('name owner');
  if (existingUnit?.owner) return existingUnit.name || normalized;

  return null;
}

// ── GET /api/owners — listar todos (admin) ────────────────────
exports.getAllOwners = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isDebtor } = req.query;

    const memberFilter = { organization: req.orgId, role: 'owner', isActive: true };
    if (isDebtor !== undefined) {
      const debtorOwnerIds = await Unit.distinct('owner', {
        organization: req.orgId,
        active: true,
        isDebtor: true,
        owner: { $ne: null },
      });
      memberFilter.user = isDebtor === 'true' ? { $in: debtorOwnerIds } : { $nin: debtorOwnerIds };
    }

    let memberships = await OrganizationMember.find(memberFilter)
      .populate('user', 'name email unitId phone phones initials lastLogin createdAt isActive')
      .lean();

    memberships = memberships.filter(m => m.user != null);

    // Cargar todas las unidades de la org para sort + search + cálculo de fee
    const [allUnits, org] = await Promise.all([
      Unit.find({ organization: req.orgId, active: true })
        .select('owner name customFee coefficient balance isDebtor startBillingPeriod')
        .lean(),
      Organization.findById(req.orgId).select('paymentPeriods monthlyFee dueDayOfMonth'),
    ]);

    const unitsByOwner    = {};
    const unitFeesByOwner = {};
    allUnits.forEach(u => {
      if (u.owner) {
        const key = u.owner.toString();
        (unitsByOwner[key]    ||= []).push(u.name);
        (unitFeesByOwner[key] ||= []).push(u);
      }
    });

    if (search) {
      const re = new RegExp(search, 'i');
      memberships = memberships.filter(m => {
        const unitNames = unitsByOwner[m.user._id.toString()] ?? [];
        return re.test(m.user.name) || re.test(m.user.email) || unitNames.some(n => re.test(n));
      });
    }

    // Ordenar por nombre de unidad
    memberships.sort((a, b) => {
      const ua = (unitsByOwner[a.user._id.toString()] ?? [])[0] ?? '';
      const ub = (unitsByOwner[b.user._id.toString()] ?? [])[0] ?? '';
      return ua.localeCompare(ub);
    });

    const total = memberships.length;
    const paged = memberships.slice((page - 1) * limit, page * limit);
    const ownerIds = paged.map(m => m.user._id);

    const [lastPayments, approvedMonthlyPayments, activePlans, planSummariesByOwner] = await Promise.all([
      Payment.aggregate([
        { $match: { owner: { $in: ownerIds }, status: 'approved' } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$owner',
            month:     { $first: '$month' },
            amount:    { $first: '$amount' },
            createdAt: { $first: '$createdAt' },
          },
        },
      ]),
      Payment.find({
        organization: req.orgId,
        owner: { $in: ownerIds },
        status: 'approved',
        month: { $exists: true, $ne: null },
      }).select('owner month units status').lean(),
      PaymentPlan.find({
        organization: req.orgId,
        owner: { $in: ownerIds },
        status: { $in: ['requested', 'approved', 'active'] },
        isActive: true,
      }).select('owner').lean(),
      getPlanSummariesByOwner({
        organizationId: req.orgId,
        ownerIds,
      }),
    ]);

    const lastPaymentByOwner = lastPayments.reduce((map, p) => {
      map[p._id.toString()] = { month: p.month, amount: p.amount, createdAt: p.createdAt };
      return map;
    }, {});

    const paymentsByOwner = approvedMonthlyPayments.reduce((map, p) => {
      const key = p.owner.toString();
      (map[key] ||= []).push(p);
      return map;
    }, {});

    const activePlanOwnerSet = new Set(activePlans.map(p => p.owner.toString()));

    let owners = paged.map(m => {
      const ownerId  = m.user._id.toString();
      const ownerUnits = unitFeesByOwner[ownerId] || [];
      const planSummary = planSummariesByOwner[ownerId] || {};
      const rawTotalOwed = computeTotalOwedByUnits(m, paymentsByOwner[ownerId] || [], ownerUnits, org);
      const excludedExtraAmount = (planSummary.plans || [])
        .filter(({ plan }) => ['requested', 'approved', 'active', 'completed'].includes(plan.status))
        .flatMap(({ debt }) => debt.extraordinaryItems || [])
        .reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const totalOwed = Math.max(0, rawTotalOwed - Math.max(0, Number(planSummary.excludedDebtAmount || 0) - excludedExtraAmount));
      const blockedMonths = new Set(planSummary.blockedMonths || []);
      const overduePeriodDetails = ownerUnits.flatMap(unit => (
        getUnpaidPeriodsForUnit(unit, m, paymentsByOwner[ownerId] || [], org || {}, ['approved'])
          .filter(period => !blockedMonths.has(period))
          .map(period => ({
            period,
            amount: calculateUnitFee(unit, org || {}),
            ...dueInfoForPeriod(period, org),
          }))
      )).filter(item => item.isOverdue);
      const balance = computeUnitsBalance(ownerUnits);
      const balanceOwed = computeUnitsBalanceOwed(ownerUnits);
      const overdueOwed = overduePeriodDetails.reduce((sum, item) => sum + Number(item.amount || 0), 0) + balanceOwed;
      const daysOverdue = Math.max(0, balanceOwed > 0 ? 1 : 0, ...overduePeriodDetails.map(item => Number(item.daysOverdue || 0)));
      return {
        ...m.user,
        balance,
        balanceOwed,
        isDebtor:           overdueOwed > 0,
        storedIsDebtor:     m.isDebtor,
        percentage:         m.percentage,
        startBillingPeriod: m.startBillingPeriod,
        role:               m.role,
        membershipId:       m._id,
        lastPayment:        lastPaymentByOwner[ownerId] ?? null,
        units:              unitsByOwner[ownerId] ?? [],
        lots:               summarizeUnitDebts(ownerUnits),
        unitDebts:          summarizeUnitDebts(ownerUnits),
        totalOwed,
        overdueOwed,
        daysOverdue,
        plannedDebtAmount:  Number(planSummary.plannedDebtAmount || 0),
        hasActivePlan:      activePlanOwnerSet.has(ownerId) || Boolean(planSummary.activePlanSummary),
        activePlanSummary:  planSummary.activePlanSummary || null,
      };
    });

    res.json({
      success: true,
      data: { owners },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/owners/me/summary - datos agregados para primera carga owner.
exports.getMySummary = async (req, res, next) => {
  try {
    const paymentsLimit = clampLimit(req.query.paymentsLimit, 50, 100);
    const noticesLimit = clampLimit(req.query.noticesLimit, 3, 20);
    const ownerId = req.ownerId;
    const membership = req.membership || await OrganizationMember.findOne({
      user:         ownerId,
      organization: req.orgId,
      role:         'owner',
      isActive:     true,
    });

    if (!membership) {
      return res.status(404).json({
        success: false,
        message: 'Propietario no encontrado en esta organizacion.',
      });
    }

    const [org, payments, units, availableItems, notices] = await Promise.all([
      Organization.findById(req.orgId).select('+mpAccessToken paymentPeriods monthlyFee feeAmount feePeriodLabel feePeriodCode lateFeeType lateFeePercent lateFeeFixed dueDayOfMonth name address cuit adminEmail adminPhone bankName bankAccount bankCbu bankHolder feeLabel memberLabel unitLabel businessType slug'),
      Payment.find({ organization: req.orgId, owner: ownerId })
        .populate('owner', 'name unit email')
        .populate('reviewedBy', 'name')
        .populate('extraordinaryItems.expense', 'description amount date attachments')
        .sort({ createdAt: -1 })
        .limit(paymentsLimit)
        .select('-__v'),
      Unit.find({ owner: ownerId, organization: req.orgId, active: true })
        .populate('owner', 'name unit email')
        .sort({ name: 1 })
        .select('-__v'),
      buildAvailablePaymentItems({
        organizationId: req.orgId,
        owner:          req.user,
        membership,
      }),
      Notice.find(buildVisibleFilterForOwner(req.orgId, ownerId))
        .populate('author', 'name')
        .sort({ sentAt: -1, createdAt: -1 })
        .limit(noticesLimit)
        .select('-__v'),
    ]);

    if (!org) {
      return res.status(404).json({
        success: false,
        message: 'Organizacion no configurada.',
      });
    }

    const config = orgToConfigView(org, false);
    const enrichedUnits = units.map(unitDoc => {
      const unit = unitDoc.toJSON();
      return {
        ...unit,
        collectionStartPeriod: unit.startBillingPeriod,
        initialDebt: Math.max(0, -normalizeDebtBalance(unit.balance)),
        previousBalance: Math.max(0, -normalizeDebtBalance(unit.balance)),
        status: unit.active === false ? 'inactive' : (unit.owner ? 'occupied' : unit.status || 'available'),
        finalFee: calcUnitFee(unitDoc, org.monthlyFee ?? 0),
      };
    });

    res.json({
      success: true,
      data: {
        config,
        membership: membership.toObject ? membership.toObject() : membership,
        units: enrichedUnits,
        payments,
        availableItems,
        notices: notices.map(notice => withIsRead(notice, ownerId)),
      },
      pagination: {
        payments: { limit: paymentsLimit },
        notices:  { limit: noticesLimit },
      },
    });
  } catch (err) {
    next(err);
  }
};

const INVOICE_MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
function formatPeriodLabel(ym) {
  if (!ym) return ym;
  const [year, m] = ym.split('-');
  return `${INVOICE_MONTHS[parseInt(m, 10) - 1] || m} ${year}`;
}

async function buildOwnerInvoiceData(ownerId, orgId, period, membership) {
  const [org, units, periodPayments, debtItems, activePlan] = await Promise.all([
    Organization.findById(orgId).select('monthlyFee paymentPeriods dueDayOfMonth name feeLabel address memberLabel'),
    Unit.find({ owner: ownerId, organization: orgId, active: true })
      .select('name customFee coefficient startBillingPeriod').lean(),
    Payment.find({ organization: orgId, owner: ownerId, month: period })
      .populate('extraordinaryItems.expense', 'description amount date category')
      .populate('reviewedBy', 'name')
      .select('-__v').lean(),
    OwnerDebtItem.find({ organization: orgId, owner: ownerId, status: 'pending' })
      .select('type description amount originDate dueDate').lean(),
    PaymentPlan.findOne({
      organization: orgId, owner: ownerId,
      status: { $in: ['requested', 'approved', 'active'] },
    }).select('status includedPeriods').lean(),
  ]);

  if (!org) {
    const e = new Error('Organización no configurada.');
    e.statusCode = 404;
    throw e;
  }

  const chargeableUnits = units.filter(u => isUnitChargeableForPeriod(u, membership, period));

  const approvedPayment  = periodPayments.find(p => p.status === 'approved');
  const pendingPayment   = periodPayments.find(p => p.status === 'pending');
  const rejectedPayments = periodPayments.filter(p => p.status === 'rejected');

  let paymentStatus;
  let monthlyItems;
  let periodAmountExpected = 0;

  if (approvedPayment) {
    paymentStatus = 'approved';
    monthlyItems  = (approvedPayment.breakdown || []).map(b => ({ unitId: b.unit, unitName: b.name, amount: b.amount }));
    periodAmountExpected = monthlyItems.reduce((s, b) => s + (b.amount || 0), 0) || approvedPayment.amount || 0;
  } else if (pendingPayment) {
    paymentStatus = 'pending';
    monthlyItems  = (pendingPayment.breakdown || []).map(b => ({ unitId: b.unit, unitName: b.name, amount: b.amount }));
    periodAmountExpected = monthlyItems.reduce((s, b) => s + (b.amount || 0), 0) || pendingPayment.amount || 0;
  } else {
    paymentStatus = rejectedPayments.length > 0 ? 'rejected' : 'unpaid';
    monthlyItems  = chargeableUnits.map(u => ({ unitId: u._id, unitName: u.name, amount: calculateUnitFee(u, org) }));
    periodAmountExpected = monthlyItems.reduce((s, i) => s + i.amount, 0);
  }

  const periodEnabled = (org.paymentPeriods || []).includes(period);
  const periodInPlan  = activePlan
    ? (activePlan.includedPeriods || []).some(p => (typeof p === 'string' ? p : p.month) === period)
    : false;

  const activePayment      = approvedPayment || pendingPayment;
  const extraordinaryItems = activePayment ? (activePayment.extraordinaryItems || []) : [];
  const totalExtraordinary = extraordinaryItems.reduce((s, e) => s + (e.amount || 0), 0);
  const totalDebt          = debtItems.reduce((s, d) => s + (d.amount || 0), 0);
  const totalCollected     = periodPayments.filter(p => p.status === 'approved').reduce((s, p) => s + (p.amount || 0), 0);
  const totalPending       = periodPayments.filter(p => p.status === 'pending').reduce((s, p) => s + (p.amount || 0), 0);

  const warnings = [];
  if (!periodEnabled) warnings.push({ code: 'period_not_enabled', message: 'Este período no está habilitado para pago.', severity: 'info' });
  if (periodInPlan)   warnings.push({ code: 'period_in_plan', message: 'Este período está incluido en un plan de pago activo.', severity: 'info' });
  if (rejectedPayments.length > 0 && paymentStatus !== 'approved') {
    warnings.push({ code: 'has_rejected', message: `Tiene ${rejectedPayments.length} pago(s) rechazado(s) para este período.`, severity: 'warning' });
  }

  return {
    period,
    periodLabel: formatPeriodLabel(period),
    paymentStatus,
    periodInPlan,
    periodEnabled,
    chargeableUnits: chargeableUnits.map(u => ({
      id: u._id, name: u.name,
      amount: calculateUnitFee(u, org),
      startBillingPeriod: u.startBillingPeriod,
    })),
    monthlyItems,
    payments: {
      approved: periodPayments.filter(p => p.status === 'approved'),
      pending:  periodPayments.filter(p => p.status === 'pending'),
      rejected: rejectedPayments,
    },
    extraordinaryItems,
    debtItems,
    dueDayOfMonth: org.dueDayOfMonth,
    totals: {
      expected:      periodAmountExpected,
      collected:     totalCollected,
      pending:       totalPending,
      extraordinary: totalExtraordinary,
      debt:          totalDebt,
    },
    warnings,
    _org: org,
  };
}

function buildInvoiceHTML(data, ownerName) {
  const fmtARS  = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n ?? 0);
  const fmtDate = (d) => new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const today   = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });
  const org     = data._org;

  const statusConfig = {
    approved: { label: 'PAGO ACREDITADO',         bg: '#d1fae5', border: '#6ee7b7', dot: '#10b981', text: '#065f46' },
    pending:  { label: 'PENDIENTE DE APROBACIÓN', bg: '#fef3c7', border: '#fcd34d', dot: '#f59e0b', text: '#92400e' },
    rejected: { label: 'PAGO RECHAZADO',          bg: '#fee2e2', border: '#fca5a5', dot: '#ef4444', text: '#991b1b' },
    unpaid:   { label: 'PENDIENTE DE PAGO',       bg: '#f3f4f6', border: '#d1d5db', dot: '#6b7280', text: '#374151' },
  };
  const st = statusConfig[data.paymentStatus] || statusConfig.unpaid;

  const monthlyRows = data.monthlyItems.map(u =>
    `<tr><td>${org.feeLabel || 'Cuota'} — ${u.unitName}</td><td style="text-align:right">${fmtARS(u.amount)}</td></tr>`
  ).join('');

  const extraRows = data.extraordinaryItems.map(e =>
    `<tr><td>${e.expense?.description || 'Gasto extraordinario'} <span style="font-size:11px;color:#6b7280">(Extraordinario)</span></td><td style="text-align:right">${fmtARS(e.amount)}</td></tr>`
  ).join('');

  const debtRows = data.debtItems.map(d =>
    `<tr><td>${d.description || 'Ajuste'} <span style="font-size:11px;color:#ef4444">(Deuda pendiente)</span></td><td style="text-align:right;color:#ef4444">+${fmtARS(d.amount)}</td></tr>`
  ).join('');

  const allPayments = [...(data.payments.approved || []), ...(data.payments.pending || []), ...(data.payments.rejected || [])];
  const stLabel = { approved: 'Aprobado', pending: 'Pendiente', rejected: 'Rechazado' };
  const stColor = { approved: '#10b981', pending: '#f59e0b', rejected: '#ef4444' };
  const paymentsSection = allPayments.length === 0 ? '' : `
<div style="margin-top:28px">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9ca3af;font-weight:600;margin-bottom:8px">Pagos del período</div>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb">
      <th style="text-align:left;padding:8px 10px;color:#6b7280;font-weight:600;font-size:11px">FECHA</th>
      <th style="text-align:left;padding:8px 10px;color:#6b7280;font-weight:600;font-size:11px">ESTADO</th>
      <th style="text-align:right;padding:8px 10px;color:#6b7280;font-weight:600;font-size:11px">IMPORTE</th>
    </tr></thead>
    <tbody>${allPayments.map(p => `<tr><td style="padding:8px 10px">${fmtDate(p.createdAt || new Date())}</td><td style="padding:8px 10px;color:${stColor[p.status] || '#6b7280'};font-weight:600">${stLabel[p.status] || p.status}</td><td style="padding:8px 10px;text-align:right">${fmtARS(p.amount)}</td></tr>`).join('')}</tbody>
  </table>
</div>`;

  const warningsSection = data.warnings.filter(w => w.severity !== 'info').map(w =>
    `<div style="display:flex;gap:8px;align-items:flex-start;background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:10px 14px;margin-top:10px;font-size:12px;color:#854d0e"><span>⚠</span><span>${w.message}</span></div>`
  ).join('');

  const totalConceptos = data.totals.expected + data.totals.extraordinary + data.totals.debt;

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Liquidación ${data.periodLabel}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#fff;color:#111827;padding:48px;font-size:14px;line-height:1.6}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:28px;border-bottom:2px solid #1a1a2e;margin-bottom:32px}
.org-name{font-size:22px;font-weight:700;color:#1a1a2e;letter-spacing:-.5px}
.org-sub{font-size:12px;color:#6b7280;margin-top:4px}
.doc-badge{text-align:right}
.doc-label{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6b7280;font-weight:600}
.doc-title{font-size:18px;font-weight:700;color:#1a1a2e;margin-top:2px}
.doc-date{font-size:12px;color:#6b7280;margin-top:4px}
.st-banner{border-radius:10px;padding:14px 20px;margin-bottom:28px;display:flex;align-items:center;gap:12px;background:${st.bg};border:1.5px solid ${st.border}}
.st-dot{width:10px;height:10px;background:${st.dot};border-radius:50%;flex-shrink:0}
.st-text{font-weight:700;font-size:14px;color:${st.text};letter-spacing:.5px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}
.info-box{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px}
.box-lbl{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9ca3af;font-weight:600;margin-bottom:6px}
.box-val{font-size:15px;font-weight:600;color:#111827}
.box-sub{font-size:12px;color:#6b7280;margin-top:2px}
table.dt{width:100%;border-collapse:collapse;margin-bottom:20px}
table.dt thead tr{background:#1a1a2e;color:#fff}
table.dt thead th{padding:12px 16px;text-align:left;font-size:12px;letter-spacing:.5px;font-weight:600}
table.dt thead th:last-child{text-align:right}
table.dt tbody tr{border-bottom:1px solid #f3f4f6}
table.dt tbody td{padding:12px 16px;font-size:14px;color:#374151}
table.dt tbody td:last-child{text-align:right;font-weight:500}
table.dt tfoot tr{border-top:2px solid #1a1a2e}
table.dt tfoot td{padding:14px 16px;font-size:16px;font-weight:700;color:#1a1a2e}
table.dt tfoot td:last-child{text-align:right}
.footer{margin-top:40px;padding-top:20px;border-top:1px solid #e5e7eb}
.disclaimer{font-size:12px;color:#6b7280;font-style:italic;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px}
.org-ftr{font-size:11px;color:#9ca3af;margin-top:8px;text-align:center;text-transform:uppercase;letter-spacing:.5px}
</style></head>
<body>
<div class="hdr">
  <div><div class="org-name">${org.name}</div><div class="org-sub">${org.address || 'Administración de propiedades'}</div></div>
  <div class="doc-badge"><div class="doc-label">Liquidación de Expensas</div><div class="doc-title">${data.periodLabel}</div><div class="doc-date">Emitida: ${today}</div></div>
</div>
<div class="st-banner"><div class="st-dot"></div><div class="st-text">${st.label}</div></div>
<div class="info-grid">
  <div class="info-box"><div class="box-lbl">${org.memberLabel || 'Propietario'}</div><div class="box-val">${ownerName}</div><div class="box-sub">${data.chargeableUnits.map(u => u.name).join(', ') || '—'}</div></div>
  <div class="info-box"><div class="box-lbl">Período</div><div class="box-val">${data.periodLabel}</div><div class="box-sub">${org.dueDayOfMonth ? `Vence el día ${org.dueDayOfMonth} de cada mes` : ''}</div></div>
</div>
<table class="dt">
  <thead><tr><th>Concepto</th><th style="text-align:right">Importe</th></tr></thead>
  <tbody>${monthlyRows}${extraRows}${debtRows}</tbody>
  <tfoot><tr><td>Total del período</td><td>${fmtARS(totalConceptos)}</td></tr></tfoot>
</table>
${paymentsSection}
${warningsSection}
<div class="footer">
  <div class="disclaimer">Esta liquidación detalla los conceptos del período <strong>${data.periodLabel}</strong>. No reemplaza el recibo de pago emitido al aprobarse el pago.</div>
  <div class="org-ftr">${org.name} — Generado automáticamente por GestionAr</div>
</div>
</body></html>`;
}

// GET /api/owners/me/invoice?period=YYYY-MM — liquidación individual del propietario autenticado
exports.getMyInvoice = async (req, res, next) => {
  try {
    const { period } = req.query;
    if (!period || !PERIOD_RE.test(period)) {
      return res.status(400).json({ success: false, message: 'El parámetro period es obligatorio (formato YYYY-MM).' });
    }
    const membership = req.membership || await OrganizationMember.findOne({
      user: req.ownerId, organization: req.orgId, role: 'owner', isActive: true,
    });
    if (!membership) {
      return res.status(404).json({ success: false, message: 'Propietario no encontrado en esta organización.' });
    }
    const data = await buildOwnerInvoiceData(req.ownerId, req.orgId, period, membership);
    const { _org, ...publicData } = data;
    res.json({ success: true, data: publicData });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    next(err);
  }
};

// GET /api/owners/me/invoice-pdf?period=YYYY-MM — PDF de liquidación individual
exports.getMyInvoicePdf = async (req, res, next) => {
  try {
    const { period } = req.query;
    if (!period || !PERIOD_RE.test(period)) {
      return res.status(400).json({ success: false, message: 'El parámetro period es obligatorio (formato YYYY-MM).' });
    }
    const [membership, owner] = await Promise.all([
      OrganizationMember.findOne({ user: req.ownerId, organization: req.orgId, role: 'owner', isActive: true }),
      User.findById(req.ownerId).select('name').lean(),
    ]);
    if (!membership) {
      return res.status(404).json({ success: false, message: 'Propietario no encontrado en esta organización.' });
    }
    const data    = await buildOwnerInvoiceData(req.ownerId, req.orgId, period, membership);
    const html    = buildInvoiceHTML(data, owner?.name || 'Propietario');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    let buffer;
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      buffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    } finally {
      await browser.close();
    }
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="liquidacion_${period}.pdf"`,
      'Content-Length':      buffer.length,
    });
    res.end(buffer);
    logger.info(`[ownerController] PDF liquidación generado owner=${req.ownerId} period=${period}`);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    logger.error(`[ownerController] Error generando PDF liquidación: ${err.message}`);
    next(err);
  }
};

// ── GET /api/owners/:id — detalle de un propietario ───────────
exports.getOwner = async (req, res, next) => {
  try {
    const membership = await OrganizationMember.findOne({
      user: req.params.id,
      organization: req.orgId,
      role: 'owner',
      isActive: true,
    }).populate('user', '-__v -password -fcmToken -passwordResetToken -passwordResetExpires');

    if (!membership || !membership.user) {
      return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });
    }

    const owner = {
      ...membership.user.toObject(),
      balance:            normalizeDebtBalance(membership.balance),
      isDebtor:           membership.isDebtor,
      percentage:         membership.percentage,
      startBillingPeriod: membership.startBillingPeriod,
      role:               membership.role,
      membershipId:       membership._id,
    };

    const [payments, org, ownerUnits] = await Promise.all([
      Payment.find({ owner: membership.user._id, organization: req.orgId })
        .sort({ createdAt: -1 })
        .select('-__v'),
      Organization.findById(req.orgId).select('paymentPeriods monthlyFee'),
      Unit.find({ owner: membership.user._id, organization: req.orgId, active: true })
        .select('name customFee coefficient balance isDebtor startBillingPeriod')
        .lean(),
    ]);
    const approvedPayments = payments.filter(p => p.status === 'approved' && p.month);
    const planSummariesByOwner = await getPlanSummariesByOwner({
      organizationId: req.orgId,
      ownerIds: [membership.user._id],
    });
    const planSummary = planSummariesByOwner[membership.user._id.toString()] || {};
    owner.balance = computeUnitsBalance(ownerUnits);
    owner.balanceOwed = Math.max(0, computeUnitsBalanceOwed(ownerUnits) - Number(planSummary.plannedBalanceAmount || 0));
    owner.isDebtor = owner.balanceOwed > 0;
    owner.unitDebts = summarizeUnitDebts(ownerUnits);
    owner.lots = summarizeUnitDebts(ownerUnits);
    owner.units = summarizeUnitDebts(ownerUnits);
    owner.totalOwed = Math.max(0, computeTotalOwedByUnits(membership, approvedPayments, ownerUnits, org || {}) - Number(planSummary.excludedDebtAmount || 0));
    owner.plannedDebtAmount = Number(planSummary.plannedDebtAmount || 0);
    owner.hasActivePlan = Boolean(planSummary.activePlanSummary);
    owner.activePlanSummary = planSummary.activePlanSummary || null;

    res.json({ success: true, data: { owner, payments } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/:id/available-items — conceptos vencidos (admin) ──
exports.getOwnerAvailableItems = async (req, res, next) => {
  try {
    const options = await getOwnerDebtOptions({
      organizationId: req.orgId,
      ownerId: req.params.id,
    });
    if (!options) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    res.json({
      success: true,
      data: {
        periods: options.periods,
        periodItems: options.periodItems,
        periodFee: options.periodItems[0]?.amount || 0,
        extraordinary: options.extraordinary,
        balanceDebt: options.balanceDebt,
        balanceUnits: options.balanceUnits,
        debtItems: options.debtItems,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/owners — crear propietario (admin) ──────────────
exports.createOwner = async (req, res, next) => {
  try {
    const allowed  = ['name', 'email', 'password', 'unit', 'phone', 'phones', 'percentage'];
    const ownerData = { role: 'owner', organization: req.orgId, createdBy: req.user._id };
    allowed.forEach((f) => { if (req.body[f] !== undefined) ownerData[f] = req.body[f]; });
    Object.assign(ownerData, normalizePhonesInput(req.body));
    if (ownerData.unit) {
      ownerData.unit = normalizeUnitName(ownerData.unit);
      const conflict = await validateLegacyUnitAvailable(req.orgId, ownerData.unit);
      if (conflict) {
        return res.status(400).json({ success: false, message: `La unidad ${conflict} ya está asignada a otro propietario.` });
      }
    }

    const initialDebtAmount = Number(req.body.initialDebtAmount ?? 0);
    if (initialDebtAmount < 0) {
      return res.status(400).json({ success: false, message: 'La deuda inicial no puede ser negativa.' });
    }
    const unitBillingSettings = normalizeUnitBillingSettings(req.body.unitBillingSettings);
    const billingSettingsError = validateUnitBillingSettings(unitBillingSettings);
    if (billingSettingsError) {
      return res.status(400).json({ success: false, message: billingSettingsError });
    }
    ownerData.balance  = 0;
    ownerData.isDebtor = false;

    const currentPeriod = formatYYYYMM(new Date());
    const chargeCurrentMonth = req.body.chargeCurrentMonth !== false;
    ownerData.startBillingPeriod = chargeCurrentMonth ? currentPeriod : getNextMonth(currentPeriod);

    const tempPassword = req.body.password;
    const requestedUnitIds = getRequestedUnitIds(req.body);
    const unitIdsWithBilling = unitBillingSettings.map(setting => setting.unitId);
    const effectiveRequestedUnitIds = requestedUnitIds.length ? requestedUnitIds : unitIdsWithBilling;
    if (initialDebtAmount > 0 && effectiveRequestedUnitIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'La deuda inicial debe asignarse al menos a una unidad.',
      });
    }

    let owner;
    let sendWelcomeEmail = true;

    if (req.body.email) {
      const existingActive = await User.findOne({ email: req.body.email, isActive: true });

      if (existingActive) {
        const membershipExists = await OrganizationMember.findOne({
          user: existingActive._id,
          organization: req.orgId,
          role: 'owner',
          isActive: true,
        });
        if (membershipExists) {
          return res.status(400).json({ success: false, message: 'El usuario ya pertenece a esta organización.' });
        }
        const preservedUnit = normalizeUnitName(ownerData.unit || existingActive.unit);
        if (preservedUnit) {
          const conflict = await validateLegacyUnitAvailable(req.orgId, preservedUnit, existingActive._id);
          if (conflict) {
            return res.status(400).json({ success: false, message: `La unidad ${conflict} ya está asignada a otro propietario.` });
          }
          ownerData.unit = preservedUnit;
        }
        const { password: _p, ...rawUpdate } = ownerData;
        const updateFields = Object.fromEntries(Object.entries(rawUpdate).filter(([k]) => EXISTING_USER_FIELDS.has(k)));
        owner = await User.findByIdAndUpdate(existingActive._id, updateFields, { new: true, runValidators: false });
        sendWelcomeEmail = false;
        logger.info(`Propietario existente vinculado: ${owner.email} [org: ${req.orgId}]`);
      } else {
        const existingInactive = await User.findOne({ email: req.body.email, isActive: false }).select('+password');
        if (existingInactive) {
          const preservedUnit = normalizeUnitName(ownerData.unit || existingInactive.unit);
          if (preservedUnit) {
            const conflict = await validateLegacyUnitAvailable(req.orgId, preservedUnit, existingInactive._id);
            if (conflict) {
              return res.status(400).json({ success: false, message: `La unidad ${conflict} ya está asignada a otro propietario.` });
            }
            ownerData.unit = preservedUnit;
          }
          const inactiveUpdate = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
          Object.assign(existingInactive, inactiveUpdate, { isActive: true });
          if (tempPassword) {
            existingInactive.password = tempPassword;
            existingInactive.mustChangePassword = true;
            existingInactive.temporaryPasswordCreatedAt = new Date();
          }
          await existingInactive.save();
          existingInactive.password = undefined;
          owner = existingInactive;
          logger.info(`Propietario reactivado: ${owner.email} [org: ${req.orgId}]`);
        }
      }
    }

    if (!owner) {
      const { error } = await findAssignableUnits(effectiveRequestedUnitIds, req.orgId, null);
      if (error) return res.status(error.status).json({ success: false, message: error.message });

      if (!req.body.password) {
        return res.status(400).json({ success: false, message: 'La contraseña es obligatoria para nuevos propietarios.' });
      }
      const userCreateData = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
      userCreateData.mustChangePassword = true;
      userCreateData.temporaryPasswordCreatedAt = new Date();
      owner = await User.create(userCreateData);
      logger.info(`Propietario creado: ${owner.email} [org: ${req.orgId}]`);
      owner.password = undefined;
    }

    const { error: unitError } = await findAssignableUnits(effectiveRequestedUnitIds, req.orgId, owner._id);
    if (unitError) return res.status(unitError.status).json({ success: false, message: unitError.message });

    await OrganizationMember.findOneAndUpdate(
      { user: owner._id, organization: req.orgId, role: 'owner' },
      {
        $set: {
          balance:            ownerData.balance,
          isDebtor:           ownerData.isDebtor,
          startBillingPeriod: ownerData.startBillingPeriod,
          percentage:         ownerData.percentage || 0,
          isActive:           true,
          createdBy:          req.user._id,
        },
      },
      { upsert: true }
    );

    // Asignar unidad si se proveyó unitId
    let assignedUnits = [];
    if (req.body.unitIds !== undefined || req.body.unitId !== undefined || unitBillingSettings.length) {
      const { units, error } = await syncOwnerUnits(owner._id, req.orgId, effectiveRequestedUnitIds);
      if (error) return res.status(error.status).json({ success: false, message: error.message });
      assignedUnits = units;
      if (unitBillingSettings.length) {
        await applyUnitBillingSettings(assignedUnits, unitBillingSettings, ownerData.startBillingPeriod);
      } else {
        await applyUnitBillingSettings(assignedUnits, [], ownerData.startBillingPeriod);
        await distributeInitialDebt(assignedUnits, initialDebtAmount);
      }
      owner = await User.findById(owner._id).select('-password -fcmToken');
    }

    if (sendWelcomeEmail) {
      sendWelcome(owner, tempPassword, assignedUnits.map(unit => unit.name)).catch((err) =>
        logger.error(`Error enviando email de bienvenida a ${owner.email}: ${err.message}`)
      );
    }

    trackUsageEvent({
      organizationId: req.orgId,
      userId: req.user._id,
      role: req.user.role,
      eventType: 'owners.created',
      module: 'owners',
      metadata: {
        ownerId: owner._id.toString(),
        createdNewUser: sendWelcomeEmail,
        assignedUnitsCount: assignedUnits.length,
      },
    });

    res.status(201).json({ success: true, data: { owner: { ...owner.toObject(), units: assignedUnits } } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/owners/:id — actualizar datos ──────────────────
exports.updateOwner = async (req, res, next) => {
  try {
    const memberFields = ['isDebtor', 'percentage', 'startBillingPeriod'];
    const userFields   = ['name', 'phone', 'phones', 'isActive'];

    const userUpdate   = {};
    const memberUpdate = {};
    [...memberFields, ...userFields].forEach((f) => {
      if (req.body[f] !== undefined) {
        if (memberFields.includes(f)) memberUpdate[f] = req.body[f];
        else userUpdate[f] = req.body[f];
      }
    });
    Object.assign(userUpdate, normalizePhonesInput(req.body));
    const unitBillingSettings = normalizeUnitBillingSettings(req.body.unitBillingSettings);
    const billingSettingsError = validateUnitBillingSettings(unitBillingSettings);
    if (billingSettingsError) {
      return res.status(400).json({ success: false, message: billingSettingsError });
    }

    // Validar cambio de email: no debe estar en uso por otro usuario activo
    if (userUpdate.email) {
      userUpdate.email = userUpdate.email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userUpdate.email)) {
        return res.status(400).json({ success: false, message: 'El email ingresado no es válido.' });
      }
      const emailConflict = await User.findOne({
        _id: { $ne: req.params.id },
        email: userUpdate.email,
        isActive: true,
      }).select('_id');
      if (emailConflict) {
        return res.status(400).json({
          success: false,
          message: 'El email ya está en uso por otro usuario.',
        });
      }
    }

    const membership = await OrganizationMember.findOne({
      user: req.params.id,
      organization: req.orgId,
      role: 'owner',
      isActive: true,
    });
    if (!membership) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    // Cambio de unidad
    let assignedUnits = null;
    if (req.body.unitIds !== undefined || req.body.unitId !== undefined) {
      const requestedUnitIds = getRequestedUnitIds(req.body);
      const { units, error } = await syncOwnerUnits(req.params.id, req.orgId, requestedUnitIds);
      if (error) return res.status(error.status).json({ success: false, message: error.message });
      assignedUnits = units;
    }

    if (unitBillingSettings.length) {
      const settingUnitIds = unitBillingSettings.map(setting => setting.unitId);
      const units = await Unit.find({
        _id: { $in: settingUnitIds },
        owner: req.params.id,
        organization: req.orgId,
        active: true,
      });
      const found = new Set(units.map(unit => unit._id.toString()));
      const missing = settingUnitIds.find(id => !found.has(id));
      if (missing) {
        return res.status(400).json({
          success: false,
          message: 'Una de las unidades no pertenece al propietario o a la organización.',
        });
      }
      await applyUnitBillingSettings(units, unitBillingSettings);
    }

    if (req.body.balance !== undefined) {
      const result = await setOwnerUnitBalance(req.params.id, req.orgId, req.body.balance);
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
    }

    await Promise.all([
      Object.keys(userUpdate).length > 0
        ? User.findByIdAndUpdate(req.params.id, userUpdate, { runValidators: true })
        : Promise.resolve(),
      Object.keys(memberUpdate).length > 0
        ? OrganizationMember.findByIdAndUpdate(membership._id, memberUpdate)
        : Promise.resolve(),
    ]);

    const [updatedUser, updatedMember] = await Promise.all([
      User.findById(req.params.id).select('-__v -password -fcmToken'),
      OrganizationMember.findById(membership._id),
    ]);

    const owner = {
      ...updatedUser.toObject(),
      balance:            0,
      isDebtor:           false,
      percentage:         updatedMember.percentage,
      startBillingPeriod: updatedMember.startBillingPeriod,
      ...(assignedUnits ? { units: assignedUnits } : {}),
    };

    const ownerUnits = await Unit.find({ owner: req.params.id, organization: req.orgId, active: true })
      .select('name balance isDebtor customFee coefficient startBillingPeriod')
      .lean();
    owner.balance = computeUnitsBalance(ownerUnits);
    owner.balanceOwed = computeUnitsBalanceOwed(ownerUnits);
    owner.isDebtor = owner.balanceOwed > 0;
    owner.unitDebts = summarizeUnitDebts(ownerUnits);
    owner.lots = summarizeUnitDebts(ownerUnits);
    owner.units = summarizeUnitDebts(ownerUnits);

    res.json({ success: true, data: { owner } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/owners/:id — desactivar (soft delete) ─────────
exports.requestEmailChange = async (req, res, next) => {
  try {
    const newEmail = String(req.body.newEmail || '').toLowerCase().trim();
    if (!EMAIL_RE.test(newEmail)) {
      return res.status(400).json({ success: false, message: 'El email ingresado no es válido.' });
    }
    if (newEmail === req.user.email) {
      return res.status(400).json({ success: false, message: 'El nuevo email debe ser distinto al actual.' });
    }

    const conflict = await User.findOne({
      _id: { $ne: req.user._id },
      email: newEmail,
      isActive: true,
    }).select('_id');
    if (conflict) {
      return res.status(400).json({
        success: false,
        message: 'El email ingresado ya está asociado a otro usuario. Contactá a la administración.',
      });
    }

    const user = await User.findById(req.user._id).select('+emailChangeToken +emailChangeTokenHash');
    user.pendingEmail = newEmail;
    const token = user.createEmailChangeToken();
    await user.save({ validateBeforeSave: false });

    const confirmUrl = `${process.env.APP_BASE_URL || ''}/confirm-email-change?token=${token}`;
    try {
      await sendEmailChangeConfirmation(user, newEmail, confirmUrl, '24 horas');
    } catch (emailErr) {
      user.pendingEmail = undefined;
      user.emailChangeToken = undefined;
      user.emailChangeTokenHash = undefined;
      user.emailChangeTokenExpiresAt = undefined;
      user.emailChangeRequestedAt = undefined;
      await user.save({ validateBeforeSave: false });
      logger.error(`[EmailChange] Error enviando confirmación a ${newEmail}: ${emailErr.message}`);
      return res.status(502).json({
        success: false,
        message: 'No pudimos enviar el email de confirmación. Intentá nuevamente más tarde.',
      });
    }

    res.json({
      success: true,
      message: 'Te enviamos un correo de confirmación a tu nuevo email.',
      ...(process.env.NODE_ENV === 'test' ? { data: { token } } : {}),
    });
  } catch (err) {
    next(err);
  }
};

exports.confirmEmailChange = async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'El token de confirmación es obligatorio.' });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      $or: [
        { emailChangeTokenHash: hashedToken },
        { emailChangeToken: hashedToken },
      ],
    }).select('+emailChangeToken +emailChangeTokenHash');

    if (!user || !user.pendingEmail) {
      return res.status(400).json({ success: false, message: 'El enlace de confirmación es inválido o ya expiró.' });
    }

    if (!user.emailChangeTokenExpiresAt || user.emailChangeTokenExpiresAt <= Date.now()) {
      user.pendingEmail = undefined;
      user.emailChangeToken = undefined;
      user.emailChangeTokenHash = undefined;
      user.emailChangeTokenExpiresAt = undefined;
      user.emailChangeRequestedAt = undefined;
      await user.save({ validateBeforeSave: false });
      return res.status(400).json({ success: false, message: 'El enlace de confirmación es inválido o ya expiró.' });
    }

    const conflict = await User.findOne({
      _id: { $ne: user._id },
      email: user.pendingEmail,
      isActive: true,
    }).select('_id');
    if (conflict) {
      return res.status(400).json({
        success: false,
        message: 'El email ingresado ya está asociado a otro usuario. Contactá a la administración.',
      });
    }

    const oldEmail = user.email;
    user.email = user.pendingEmail;
    user.pendingEmail = undefined;
    user.emailChangeToken = undefined;
    user.emailChangeTokenHash = undefined;
    user.emailChangeTokenExpiresAt = undefined;
    user.emailChangeRequestedAt = undefined;
    user.emailChangedAt = new Date();
    user.emailVerifiedAt = new Date();
    await user.save({ validateBeforeSave: false });

    logger.info(`[EmailChange] Email actualizado para user=${user._id}: ${oldEmail} -> ${user.email}`);
    res.json({
      success: true,
      message: 'Tu email fue actualizado correctamente.',
      data: { email: user.email },
    });
  } catch (err) {
    next(err);
  }
};

exports.cancelEmailChange = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+emailChangeToken +emailChangeTokenHash');
    if (!user) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
    }

    user.pendingEmail = undefined;
    user.emailChangeToken = undefined;
    user.emailChangeTokenHash = undefined;
    user.emailChangeTokenExpiresAt = undefined;
    user.emailChangeRequestedAt = undefined;
    await user.save({ validateBeforeSave: false });

    res.json({ success: true, message: 'La solicitud de cambio de email fue cancelada.' });
  } catch (err) {
    next(err);
  }
};

exports.deleteOwner = async (req, res, next) => {
  try {
    const membership = await OrganizationMember.findOneAndUpdate(
      { user: req.params.id, organization: req.orgId, role: 'owner', isActive: true },
      { isActive: false },
      { new: true }
    );
    if (!membership) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    // Liberar todas las unidades asignadas a este propietario en esta org.
    await Promise.all([
      Unit.updateMany(
        { owner: req.params.id, organization: req.orgId, active: true },
        { owner: null, status: 'available' }
      ),
      User.findByIdAndUpdate(req.params.id, { unitId: null }),
    ]);

    // Desactivar User solo si no tiene otras membresías activas
    const remaining = await OrganizationMember.countDocuments({
      user: req.params.id,
      isActive: true,
    });
    if (remaining === 0) {
      await User.findByIdAndUpdate(req.params.id, { isActive: false });
    }

    logger.info(`Propietario desactivado: userId=${req.params.id} org=${req.orgId}`);
    res.json({ success: true, message: 'Propietario desactivado correctamente.' });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/owners/:id/notify — enviar push a un propietario ─
exports.notifyOwner = async (req, res, next) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ success: false, message: 'title y body son requeridos.' });

    const membership = await OrganizationMember.findOne({
      user: req.params.id,
      organization: req.orgId,
      role: 'owner',
      isActive: true,
    }).populate('user', 'email');
    if (!membership) return res.status(404).json({ success: false, message: 'Propietario no encontrado.' });

    await sendToUser(req.params.id, { title, body, data: { type: 'admin_message' } });
    logger.info(`Push enviado a ${membership.user.email} por admin ${req.user.email}`);
    res.json({ success: true, message: 'Notificación enviada.' });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/bulk/template — descargar plantilla Excel ─
exports.downloadBulkTemplate = (_req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['nombre', 'email', 'contraseña', 'telefono', 'telefonos', 'saldo', 'moroso'],
    ['María García', 'maria@mail.com', 'clave123', '1122334455', '1122334455; 1199887766', '0', 'no'],
    ['Juan Pérez',   'juan@mail.com',  'clave456', '',           '',                       '0', 'no'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Propietarios');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_propietarios.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

// ── POST /api/owners/bulk — carga masiva desde Excel (admin) ──
exports.bulkCreateOwners = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Se requiere un archivo Excel (.xlsx).' });
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch {
      return res.status(400).json({ success: false, message: 'El archivo no es un Excel válido.' });
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows  = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'El archivo está vacío o no tiene filas de datos.' });
    }

    const COL_MAP = {
      nombre:       'name',
      email:        'email',
      'contraseña': 'password',
      telefono:     'phone',
      telefonos:    'phones',
      saldo:        'balance',
      moroso:       'isDebtor',
      name: 'name', password: 'password', phone: 'phone', phones: 'phones',
      balance: 'balance', isDebtor: 'isDebtor',
    };
    const created = [];
    const errors  = [];

    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const rowNum = i + 2;

      const ownerData = { role: 'owner', organization: req.orgId, createdBy: req.user._id, startBillingPeriod: formatYYYYMM(new Date()) };
      Object.entries(row).forEach(([col, val]) => {
        const field = COL_MAP[col.trim().toLowerCase()] || COL_MAP[col.trim()];
        if (field && val !== undefined && val !== '') ownerData[field] = val;
      });

      if (ownerData.balance !== undefined) ownerData.balance = normalizeDebtBalance(ownerData.balance);
      Object.assign(ownerData, normalizePhonesInput(ownerData));
      if (ownerData.isDebtor !== undefined) {
        const v = String(ownerData.isDebtor).toLowerCase();
        ownerData.isDebtor = v === 'true' || v === '1' || v === 'si' || v === 'sí';
      }
      if (ownerData.balance !== undefined) ownerData.isDebtor = ownerData.balance < 0;

      if (!ownerData.name || !ownerData.email) {
        errors.push({ row: rowNum, email: ownerData.email || '', reason: 'nombre y email son obligatorios.' });
        continue;
      }

      try {
        let owner;
        let sendEmail = true;

        const existingActive = await User.findOne({ email: ownerData.email, isActive: true });

        if (existingActive) {
          const membershipExists = await OrganizationMember.findOne({
            user: existingActive._id,
            organization: req.orgId,
            role: 'owner',
            isActive: true,
          });
          if (membershipExists) {
            errors.push({ row: rowNum, email: ownerData.email, reason: 'El usuario ya pertenece a esta organización.' });
            continue;
          }
          const { password: _p, ...rawBulkUpdate } = ownerData;
          const bulkUpdateFields = Object.fromEntries(Object.entries(rawBulkUpdate).filter(([k]) => EXISTING_USER_FIELDS.has(k)));
          owner = await User.findByIdAndUpdate(existingActive._id, bulkUpdateFields, { new: true, runValidators: false });
          sendEmail = false;
          logger.info(`Bulk: propietario existente vinculado ${owner.email} [org: ${req.orgId}]`);
        } else {
          const existingInactive = await User.findOne({ email: ownerData.email, isActive: false }).select('+password');
          if (existingInactive) {
            const rawPassword = ownerData.password;
            const inactiveUpdate = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
            Object.assign(existingInactive, inactiveUpdate, { isActive: true });
            if (rawPassword) {
              existingInactive.password = rawPassword;
              existingInactive.mustChangePassword = true;
              existingInactive.temporaryPasswordCreatedAt = new Date();
            }
            await existingInactive.save();
            existingInactive.password = undefined;
            owner = existingInactive;
            logger.info(`Bulk: propietario reactivado ${owner.email} [org: ${req.orgId}]`);
          } else {
            if (!ownerData.password) {
              errors.push({ row: rowNum, email: ownerData.email, reason: 'La contraseña es obligatoria para nuevos propietarios.' });
              continue;
            }
            const rawPassword = ownerData.password;
            const bulkCreateData = Object.fromEntries(Object.entries(ownerData).filter(([k]) => USER_FIELDS.has(k)));
            bulkCreateData.mustChangePassword = true;
            bulkCreateData.temporaryPasswordCreatedAt = new Date();
            owner = await User.create(bulkCreateData);
            logger.info(`Bulk: propietario creado ${owner.email} [org: ${req.orgId}]`);
            owner.password = undefined;

            if (sendEmail) {
              sendWelcome(owner, rawPassword, []).catch((err) =>
                logger.error(`Bulk: error enviando email a ${owner.email}: ${err.message}`)
              );
            }
          }
        }

        await OrganizationMember.findOneAndUpdate(
          { user: owner._id, organization: req.orgId, role: 'owner' },
          {
            $set: {
              balance:            ownerData.balance ?? 0,
              isDebtor:           ownerData.isDebtor ?? false,
              startBillingPeriod: ownerData.startBillingPeriod,
              percentage:         ownerData.percentage || 0,
              isActive:           true,
              createdBy:          req.user._id,
            },
          },
          { upsert: true }
        );

        created.push(owner);
      } catch (err) {
        let reason = 'Error al crear el propietario.';
        if (err.code === 11000) reason = 'El email ya está registrado en esta organización.';
        else if (err.name === 'ValidationError') reason = Object.values(err.errors).map((e) => e.message).join(' ');
        errors.push({ row: rowNum, email: ownerData.email || '', reason });
      }
    }

    res.status(201).json({
      success: true,
      data: {
        created: created.length,
        errors:  errors.length,
        owners:  created,
        failed:  errors,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/check-email — verificar si email existe (admin) ──
exports.checkEmail = async (req, res, next) => {
  try {
    const { email } = req.query;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Email inválido.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim(), isActive: true }).select('_id');

    if (!user) {
      return res.json({
        success: true,
        exists: false,
        belongsToCurrentOrganization: false,
        canAddToCurrentOrganization: true,
        message: 'El email no está registrado. Se creará un nuevo usuario.',
      });
    }

    const membership = await OrganizationMember.findOne({
      user: user._id,
      organization: req.orgId,
      role: 'owner',
      isActive: true,
    });

    if (membership) {
      return res.json({
        success: true,
        exists: true,
        belongsToCurrentOrganization: true,
        canAddToCurrentOrganization: false,
        message: 'Este usuario ya pertenece a esta organización.',
      });
    }

    return res.json({
      success: true,
      exists: true,
      belongsToCurrentOrganization: false,
      canAddToCurrentOrganization: true,
      message: 'Este usuario ya existe. Se asociará a esta organización y conservará su contraseña actual.',
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/owners/stats — estadísticas generales (admin) ────
exports.getStats = async (req, res, next) => {
  try {
    const orgFilter = { organization: req.orgId };

    const [memberships, org, units, payments] = await Promise.all([
      OrganizationMember.find({ organization: req.orgId, role: 'owner', isActive: true })
        .select('user balance startBillingPeriod percentage')
        .lean(),
      Organization.findById(req.orgId).select('paymentPeriods monthlyFee').lean(),
      Unit.find({ organization: req.orgId, active: true })
        .select('owner customFee coefficient balance isDebtor startBillingPeriod')
        .lean(),
      Payment.find({ ...orgFilter, status: 'approved' }).select('owner amount month units status').lean(),
    ]);

    const totalOwners = memberships.length;
    const totalCollected = payments.reduce((sum, p) => sum + p.amount, 0);
    const unitsByOwner = {};
    units.forEach(unit => {
      if (!unit.owner) return;
      const ownerId = unit.owner.toString();
      (unitsByOwner[ownerId] ||= []).push(unit);
    });
    const paymentsByOwner = {};
    payments.forEach(payment => {
      if (!payment.owner) return;
      const ownerId = payment.owner.toString();
      (paymentsByOwner[ownerId] ||= []).push(payment);
    });
    const debtors = memberships.filter(membership => {
      const ownerId = membership.user?.toString();
      if (!ownerId) return false;
      const totalOwed = computeTotalOwedByUnits(
        membership,
        paymentsByOwner[ownerId] || [],
        unitsByOwner[ownerId] || [],
        org || {}
      );
      return totalOwed > 0.01;
    }).length;

    const monthlyAgg = await Payment.aggregate([
      { $match: { ...orgFilter, status: 'approved' } },
      { $group: { _id: '$month', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
      { $limit: 6 },
    ]);

    res.json({
      success: true,
      data: {
        totalOwners,
        debtors,
        upToDate: totalOwners - debtors,
        complianceRate: totalOwners > 0 ? Math.round(((totalOwners - debtors) / totalOwners) * 100) : 0,
        totalCollected,
        pendingPayments: await Payment.countDocuments({ ...orgFilter, status: 'pending' }),
        monthlyStats: monthlyAgg,
      },
    });
  } catch (err) {
    next(err);
  }
};
