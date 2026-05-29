const mongoose = require('mongoose');
const DelinquencyReminder = require('../models/DelinquencyReminder');
const Expense = require('../models/Expense');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const OwnerDebtItem = require('../models/OwnerDebtItem');
const Payment = require('../models/Payment');
const PaymentPlanInstallment = require('../models/PaymentPlanInstallment');
const Unit = require('../models/Unit');
const User = require('../models/User');
const { calculateExtraordinaryAmountForOwner } = require('./expenseService');
const { createCommunication } = require('./communicationService');
const {
  buildBillableUnitsContext,
  getPlanSummariesByOwner,
} = require('./paymentPlanDebtService');
const {
  calculateUnitFee,
  computeUnitBalanceOwed,
  computeUnitsBalance,
  computeUnitsBalanceOwed,
  getChargeablePeriodsForUnit,
  getPaidMonthsForUnit,
  getUnitStartBillingPeriod,
  getUnpaidPeriodsForUnit,
  normalizeDebtBalance,
  summarizeUnitDebts,
} = require('../utils/ownerFinance');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATES = ['al_dia', 'deuda_leve', 'deuda_media', 'deuda_alta', 'mora_critica'];
const SORTS = ['debt_desc', 'days_desc', 'name', 'unit', 'last_payment'];

const oid = value => (value?._id || value)?.toString();
const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    return { dueDate: null, dueDateLabel: 'sin vencimiento definido', daysOverdue: 0, isOverdue: false };
  }
  const [year, month] = period.split('-').map(Number);
  const day = Math.min(Math.max(Number(org.dueDayOfMonth || 10), 1), 28);
  const dueParts = { year, month, day };
  const todayParts = argentinaParts(now);
  const daysOverdue = Math.max(0, dayOrdinal(todayParts) - dayOrdinal(dueParts));
  const dueDate = new Date(Date.UTC(year, month - 1, day, 3, 0, 0, 0));
  return {
    dueDate,
    dueDateLabel: dueDate.toISOString(),
    daysOverdue,
    isOverdue: daysOverdue > 0,
  };
}

function summarizePayment(payment) {
  return {
    id: payment._id,
    _id: payment._id,
    month: payment.month || null,
    amount: Number(payment.amount || 0),
    status: payment.status,
    type: payment.type,
    paymentMethod: payment.paymentMethod,
    createdAt: payment.createdAt,
    reviewedAt: payment.reviewedAt,
    receiptNumber: payment.receiptNumber || null,
    hasReceipt: Boolean(payment.receipt?.url),
    hasSystemReceipt: Boolean(payment.systemReceipt?.url),
  };
}

function legacyUnitForMembership(membership) {
  const user = membership.user;
  if (!user || (!user.unit && !user.unitId)) return null;
  return {
    _id: user.unitId || user._id,
    name: user.unit || 'Unidad',
    owner: user._id,
    coefficient: membership.percentage > 0 ? membership.percentage : 1,
    startBillingPeriod: membership.startBillingPeriod,
    active: true,
    legacy: true,
  };
}

async function buildDelinquencyRows(organizationId) {
  let memberships = await OrganizationMember.find({
    organization: organizationId,
    role: 'owner',
    isActive: true,
  })
    .populate('user', 'name email phone phones unit unitId isActive startBillingPeriod')
    .lean();
  memberships = memberships.filter(m => m.user);

  const ownerIds = memberships.map(m => m.user._id);
  const [org, units, payments, expenses, debtItems, planSummariesByOwner, reminderStats, overdueInstallments] = await Promise.all([
    Organization.findById(organizationId).select('name paymentPeriods monthlyFee feePeriodCode dueDayOfMonth feeLabel unitLabel memberLabel').lean(),
    Unit.find({ organization: organizationId, active: true })
      .select('owner name customFee coefficient balance isDebtor startBillingPeriod active status')
      .lean(),
    Payment.find({ organization: organizationId, owner: { $in: ownerIds } })
      .select('-__v')
      .sort({ createdAt: -1 })
      .lean(),
    Expense.find({
      organization: organizationId,
      expenseType: 'extraordinary',
      isChargeable: true,
      isActive: { $ne: false },
    }).select('_id description amount date extraordinaryBillingMode unitAmount appliesToAllOwners targetUnits')
      .sort({ date: -1, createdAt: -1 })
      .lean(),
    OwnerDebtItem.find({
      organization: organizationId,
      owner: { $in: ownerIds },
      isActive: { $ne: false },
      status: 'pending',
    }).lean(),
    getPlanSummariesByOwner({ organizationId, ownerIds }),
    DelinquencyReminder.aggregate([
      { $match: { organization: organizationId } },
      { $group: { _id: '$owner', lastReminderAt: { $max: '$sentAt' }, remindersCount: { $sum: 1 } } },
    ]),
    PaymentPlanInstallment.find({ organization: organizationId, status: 'overdue' }).select('owner').lean(),
  ]);

  const reminderByOwner = Object.fromEntries(reminderStats.map(r => [String(r._id), r]));
  const overdueByOwner = {};
  for (const inst of overdueInstallments) {
    const k = String(inst.owner);
    overdueByOwner[k] = (overdueByOwner[k] || 0) + 1;
  }

  const { allUnits: billableUnits, unitsByOwner } = buildBillableUnitsContext(memberships, units);
  const paymentsByOwner = {};
  payments.forEach(payment => {
    const key = payment.owner.toString();
    (paymentsByOwner[key] ||= []).push(payment);
  });
  const debtItemsByOwner = {};
  debtItems.forEach(item => {
    const key = item.owner.toString();
    (debtItemsByOwner[key] ||= []).push(item);
  });

  return memberships.map(membership => {
    const owner = membership.user;
    const ownerId = owner._id.toString();
    let ownerUnits = unitsByOwner[ownerId] || [];
    if (!ownerUnits.length) {
      const legacyUnit = legacyUnitForMembership(membership);
      if (legacyUnit) ownerUnits = [legacyUnit];
    }
    const ownerPayments = paymentsByOwner[ownerId] || [];
    const planSummary = planSummariesByOwner[ownerId] || {};
    const blockedMonths = new Set(planSummary.blockedMonths || []);
    const blockedExtraIds = new Set(planSummary.blockedExtraIds || []);
    const blockedDebtItemIds = new Set(planSummary.blockedDebtItemIds || []);
    const pendingPayments = ownerPayments.filter(p => p.status === 'pending').map(summarizePayment);
    const rejectedPayments = ownerPayments.filter(p => p.status === 'rejected').map(summarizePayment);
    const approvedPayments = ownerPayments.filter(p => p.status === 'approved').map(summarizePayment);
    const lastPaymentRaw = ownerPayments.find(p => p.status === 'approved');

    const unpaidPeriodMap = new Map();
    ownerUnits.forEach(unit => {
      const unpaid = getUnpaidPeriodsForUnit(unit, membership, ownerPayments, org || {}, ['approved'])
        .filter(period => !blockedMonths.has(period));
      unpaid.forEach(period => {
        const current = unpaidPeriodMap.get(period) || {
          period,
          amount: 0,
          units: [],
          ...dueInfoForPeriod(period, org),
        };
        current.amount += calculateUnitFee(unit, org || {});
        current.units.push({
          id: oid(unit),
          _id: unit._id || unit.id,
          name: unit.name || 'Unidad',
          amount: calculateUnitFee(unit, org || {}),
          startBillingPeriod: getUnitStartBillingPeriod(unit, membership) || owner.startBillingPeriod,
        });
        unpaidPeriodMap.set(period, current);
      });
    });
    const unpaidPeriods = [...unpaidPeriodMap.values()].sort((a, b) => a.period.localeCompare(b.period));

    const paidExtraIds = new Set(
      ownerPayments
        .filter(p => ['pending', 'approved'].includes(p.status))
        .flatMap(p => (p.extraordinaryItems || []).map(item => item.expense?.toString()).filter(Boolean))
    );
    const extraordinaryOwed = expenses
      .filter(expense => !paidExtraIds.has(expense._id.toString()) && !blockedExtraIds.has(expense._id.toString()))
      .map(expense => {
        const { amountForOwner } = calculateExtraordinaryAmountForOwner(expense, ownerUnits, billableUnits);
        if (amountForOwner === 0 && ['per_unit', 'by_coefficient'].includes(expense.extraordinaryBillingMode)) return null;
        const period = expense.date ? expense.date.toISOString().slice(0, 7) : null;
        return {
          id: expense._id,
          _id: expense._id,
          title: expense.description || 'Concepto extraordinario',
          amount: Number(amountForOwner || 0),
          period,
          date: expense.date,
          ...(period ? dueInfoForPeriod(period, org) : { dueDate: null, dueDateLabel: 'sin vencimiento definido', daysOverdue: 0, isOverdue: false }),
        };
      })
      .filter(Boolean);

    let legacyBalanceRemaining = 0;
    const balanceUnits = ownerUnits.map(unit => {
      const rawOwed = computeUnitBalanceOwed(unit);
      const unitId = oid(unit);
      const planned = Number(planSummary.plannedBalanceByUnit?.[unitId] || 0);
      const legacyApplied = Math.min(Math.max(0, rawOwed - planned), legacyBalanceRemaining);
      legacyBalanceRemaining -= legacyApplied;
      const amount = Math.max(0, rawOwed - planned - legacyApplied);
      return {
        id: unit._id || unit.id,
        _id: unit._id || unit.id,
        name: unit.name || 'Unidad',
        amount,
        balance: normalizeDebtBalance(unit.balance),
      };
    }).filter(item => item.amount > 0);

    const ownerDebtItems = (debtItemsByOwner[ownerId] || [])
      .filter(item => !blockedDebtItemIds.has(item._id.toString()))
      .map(item => {
        const period = item.dueDate ? item.dueDate.toISOString().slice(0, 7) : null;
        const due = item.dueDate
          ? {
              dueDate: item.dueDate,
              dueDateLabel: item.dueDate.toISOString(),
              daysOverdue: Math.max(0, dayOrdinal(argentinaParts(nowForCalculations())) - dayOrdinal(argentinaParts(item.dueDate))),
              isOverdue: item.dueDate < nowForCalculations(),
            }
          : { dueDate: null, dueDateLabel: 'sin vencimiento definido', daysOverdue: 0, isOverdue: false };
        return {
          id: item._id,
          _id: item._id,
          type: item.type,
          description: item.description,
          amount: Number(item.amount || 0),
          currency: item.currency || 'ARS',
          period,
          originDate: item.originDate,
          ...due,
        };
      });

    const periodDebt = unpaidPeriods.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const balanceOwed = Math.max(0, balanceUnits.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    const extraordinaryTotal = extraordinaryOwed.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const debtItemsTotal = ownerDebtItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const totalOwed = Math.max(0, periodDebt + balanceOwed + extraordinaryTotal + debtItemsTotal);
    const allDebtConcepts = [
      ...unpaidPeriods,
      ...extraordinaryOwed,
      ...ownerDebtItems,
      ...balanceUnits.map(item => ({ ...item, daysOverdue: 0, period: null })),
    ];
    const daysOverdue = Math.max(0, ...allDebtConcepts.map(item => Number(item.daysOverdue || 0)));
    const oldestPeriod = unpaidPeriods[0]?.period
      || extraordinaryOwed.map(e => e.period).filter(Boolean).sort()[0]
      || null;
    const monthlyPeriodsCount = unpaidPeriods.length;
    const ownerBaseFee = ownerUnits.reduce((sum, unit) => sum + calculateUnitFee(unit, org || {}), 0);
    const status = getDelinquencyStatus({
      totalOwed,
      periodsCount: monthlyPeriodsCount,
      daysOverdue,
      ownerBaseFee,
    });

    const remInfo = reminderByOwner[ownerId] || {};
    const lastReminderAt = remInfo.lastReminderAt || null;
    const remindersCount = remInfo.remindersCount || 0;
    const overdueInstallmentsCount = overdueByOwner[ownerId] || 0;
    const riskIntelligence = computeRiskIntelligence({
      periodsCount: monthlyPeriodsCount,
      daysOverdue,
      totalOwed,
      hasActivePlan: Boolean(planSummary.activePlanSummary),
      overdueInstallmentsCount,
      pendingPaymentsCount: pendingPayments.length,
      lastReminderAt,
      remindersCount,
    });

    return {
      id: owner._id,
      _id: owner._id,
      membershipId: membership._id,
      name: owner.name,
      email: owner.email,
      phone: owner.phone,
      phones: owner.phones || [],
      unit: owner.unit,
      units: ownerUnits.map(unit => ({ id: oid(unit), _id: unit._id || unit.id, name: unit.name || 'Unidad' })),
      unitNames: ownerUnits.map(unit => unit.name || 'Unidad').sort((a, b) => a.localeCompare(b)),
      totalOwed,
      periodDebt,
      balanceOwed,
      extraordinaryDebt: extraordinaryTotal,
      debtItemsDebt: debtItemsTotal,
      plannedDebtAmount: Number(planSummary.plannedDebtAmount || 0),
      hasActivePlan: Boolean(planSummary.activePlanSummary),
      activePlanSummary: planSummary.activePlanSummary || null,
      status,
      state: status,
      periodsCount: monthlyPeriodsCount,
      unpaidPeriods: unpaidPeriods.map(item => item.period),
      unpaidPeriodDetails: unpaidPeriods,
      oldestPeriod,
      daysOverdue,
      pendingPayments,
      pendingPaymentsCount: pendingPayments.length,
      pendingPaymentsAmount: pendingPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0),
      rejectedPayments,
      approvedPayments,
      lastPayment: lastPaymentRaw ? summarizePayment(lastPaymentRaw) : null,
      startBillingPeriod: membership.startBillingPeriod,
      unitDebts: summarizeUnitDebts(ownerUnits),
      balanceUnits,
      extraordinaryOwed,
      debtItems: ownerDebtItems,
      interest: {
        interestEnabled: false,
        interestType: null,
        interestRate: 0,
        interestStartAfterDays: null,
        calculatedInterest: 0,
        debtWithoutInterest: totalOwed,
        debtWithInterest: totalOwed,
      },
      rawBalance: computeUnitsBalance(ownerUnits),
      rawBalanceOwed: computeUnitsBalanceOwed(ownerUnits),
      lastReminderAt,
      remindersCount,
      overdueInstallmentsCount,
      ...riskIntelligence,
    };
  });
}

function getDelinquencyStatus({ totalOwed, periodsCount, daysOverdue, ownerBaseFee }) {
  if (totalOwed <= 0) return 'al_dia';
  if (daysOverdue >= 90 || (ownerBaseFee > 0 && totalOwed >= ownerBaseFee * 3)) return 'mora_critica';
  if (periodsCount >= 3) return 'deuda_alta';
  if (periodsCount === 2) return 'deuda_media';
  return 'deuda_leve';
}

const REMINDER_COOLDOWN_DAYS = 14;

function computeRiskIntelligence({ periodsCount, daysOverdue, totalOwed, hasActivePlan, overdueInstallmentsCount, pendingPaymentsCount, lastReminderAt, remindersCount }) {
  if (totalOwed <= 0) return { riskLevel: 'sin_deuda', riskScore: 0, riskReasons: [], suggestedActions: [] };

  const reasons = [];
  const now = nowForCalculations();
  const daysSinceReminder = lastReminderAt ? Math.floor((now - new Date(lastReminderAt)) / 86400000) : null;

  let level = periodsCount <= 1 ? 'bajo' : periodsCount <= 3 ? 'medio' : 'alto';

  if (periodsCount > 0) reasons.push(`Debe ${periodsCount} período${periodsCount > 1 ? 's' : ''}`);

  if (daysOverdue >= 90) reasons.push('Deuda con más de 90 días de atraso');
  else if (daysOverdue >= 60) reasons.push('Deuda con más de 60 días de atraso');

  if (hasActivePlan && overdueInstallmentsCount === 0) {
    if (level === 'alto') level = 'medio';
    else if (level === 'medio') level = 'bajo';
    reasons.push('Tiene plan de pago activo al día');
  }

  if (overdueInstallmentsCount > 0) {
    reasons.push(`Tiene ${overdueInstallmentsCount} cuota${overdueInstallmentsCount > 1 ? 's' : ''} de plan vencida${overdueInstallmentsCount > 1 ? 's' : ''}`);
    if (level === 'alto') level = 'critico';
    else if (level === 'medio') level = 'alto';
  }

  if (daysOverdue >= 90 && !hasActivePlan) level = 'critico';
  if (level === 'alto' && (daysSinceReminder === null || daysSinceReminder > 30)) level = 'critico';

  if (pendingPaymentsCount > 0) {
    reasons.push(`Tiene ${pendingPaymentsCount} pago${pendingPaymentsCount > 1 ? 's' : ''} pendiente${pendingPaymentsCount > 1 ? 's' : ''} de aprobación`);
  }

  if (!lastReminderAt) reasons.push('Sin recordatorios registrados');
  else if (daysSinceReminder > 30) reasons.push(`Sin recordatorio reciente (último hace ${daysSinceReminder} días)`);

  const LEVEL_SCORES = { bajo: 15, medio: 35, alto: 60, critico: 85 };
  const riskScore = LEVEL_SCORES[level] || 15;

  const actions = [];
  if (pendingPaymentsCount > 0) actions.push('review_pending_payment');
  if (overdueInstallmentsCount > 0) actions.push('review_payment_plan');
  if (pendingPaymentsCount === 0) {
    if (daysSinceReminder === null || daysSinceReminder > REMINDER_COOLDOWN_DAYS) actions.push('send_reminder');
    else actions.push('wait_for_response');
  }
  if (!hasActivePlan && periodsCount >= 2) actions.push('create_payment_plan');
  actions.push('view_detail');
  if (!hasActivePlan) actions.push('register_adjustment');

  return { riskLevel: level, riskScore, riskReasons: reasons, suggestedActions: actions };
}

function applyFilters(rows, filters = {}) {
  let result = [...rows];
  const search = String(filters.search || '').trim();
  if (search) {
    const re = new RegExp(escapeRegExp(search), 'i');
    result = result.filter(row =>
      re.test(row.name || '')
      || re.test(row.email || '')
      || re.test(row.unit || '')
      || row.unitNames.some(name => re.test(name))
    );
  }
  if (filters.period && PERIOD_RE.test(filters.period)) {
    result = result.filter(row =>
      row.unpaidPeriods.includes(filters.period)
      || row.pendingPayments.some(payment => payment.month === filters.period)
      || row.approvedPayments.some(payment => payment.month === filters.period)
      || row.extraordinaryOwed.some(item => item.period === filters.period)
    );
  }
  const minDebt = filters.minDebt !== undefined ? toNumber(filters.minDebt, null) : null;
  const maxDebt = filters.maxDebt !== undefined ? toNumber(filters.maxDebt, null) : null;
  if (minDebt !== null) result = result.filter(row => row.totalOwed >= minDebt);
  if (maxDebt !== null) result = result.filter(row => row.totalOwed <= maxDebt);
  const minPeriods = filters.minPeriods !== undefined ? toNumber(filters.minPeriods, null) : null;
  const maxPeriods = filters.maxPeriods !== undefined ? toNumber(filters.maxPeriods, null) : null;
  if (minPeriods !== null) result = result.filter(row => row.periodsCount >= minPeriods);
  if (maxPeriods !== null) result = result.filter(row => row.periodsCount <= maxPeriods);
  const minDays = filters.minDaysOverdue !== undefined ? toNumber(filters.minDaysOverdue, null) : null;
  const maxDays = filters.maxDaysOverdue !== undefined ? toNumber(filters.maxDaysOverdue, null) : null;
  if (minDays !== null) result = result.filter(row => row.daysOverdue >= minDays);
  if (maxDays !== null) result = result.filter(row => row.daysOverdue <= maxDays);
  if (filters.status && STATES.includes(filters.status)) result = result.filter(row => row.status === filters.status);
  if (filters.unitId && mongoose.Types.ObjectId.isValid(filters.unitId)) {
    result = result.filter(row => row.units.some(unit => oid(unit) === String(filters.unitId)));
  }
  if (String(filters.pendingReview || '') === 'true') result = result.filter(row => row.pendingPaymentsCount > 0);
  if (String(filters.criticalOnly || '') === 'true') result = result.filter(row => row.status === 'mora_critica');
  if (filters.hasActivePlan === 'yes') result = result.filter(row => row.hasActivePlan === true);
  if (filters.hasActivePlan === 'no') result = result.filter(row => !row.hasActivePlan);
  const reminderDays = filters.reminderDays !== undefined ? toNumber(filters.reminderDays, null) : null;
  if (reminderDays !== null) {
    const now = nowForCalculations();
    result = result.filter(row => {
      if (!row.lastReminderAt) return true;
      return Math.floor((now - new Date(row.lastReminderAt)) / 86400000) >= reminderDays;
    });
  }
  if (filters.lastPaymentFrom) {
    const from = new Date(filters.lastPaymentFrom);
    if (!Number.isNaN(from.getTime())) result = result.filter(row => row.lastPayment?.createdAt && new Date(row.lastPayment.createdAt) >= from);
  }
  if (filters.lastPaymentTo) {
    const to = new Date(filters.lastPaymentTo);
    if (!Number.isNaN(to.getTime())) result = result.filter(row => row.lastPayment?.createdAt && new Date(row.lastPayment.createdAt) <= to);
  }
  return result;
}

function sortRows(rows, sort = 'debt_desc') {
  const mode = SORTS.includes(sort) ? sort : 'debt_desc';
  return rows.sort((a, b) => {
    if (mode === 'name') return a.name.localeCompare(b.name);
    if (mode === 'unit') return (a.unitNames[0] || '').localeCompare(b.unitNames[0] || '') || a.name.localeCompare(b.name);
    if (mode === 'last_payment') {
      const aTime = a.lastPayment?.createdAt ? new Date(a.lastPayment.createdAt).getTime() : 0;
      const bTime = b.lastPayment?.createdAt ? new Date(b.lastPayment.createdAt).getTime() : 0;
      return bTime - aTime || a.name.localeCompare(b.name);
    }
    if (mode === 'days_desc') return b.daysOverdue - a.daysOverdue || b.totalOwed - a.totalOwed;
    return b.totalOwed - a.totalOwed || b.daysOverdue - a.daysOverdue || a.name.localeCompare(b.name);
  });
}

function publicOwnerRow(row) {
  return {
    id: row.id,
    _id: row._id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    unit: row.unit,
    units: row.unitNames,
    unitDetails: row.units,
    totalOwed: row.totalOwed,
    periodDebt: row.periodDebt,
    balanceOwed: row.balanceOwed,
    extraordinaryDebt: row.extraordinaryDebt,
    debtItemsDebt: row.debtItemsDebt,
    periodsCount: row.periodsCount,
    unpaidPeriods: row.unpaidPeriods,
    oldestPeriod: row.oldestPeriod,
    daysOverdue: row.daysOverdue,
    pendingPaymentsCount: row.pendingPaymentsCount,
    pendingPaymentsAmount: row.pendingPaymentsAmount,
    lastPayment: row.lastPayment,
    status: row.status,
    state: row.state,
    hasActivePlan: row.hasActivePlan,
    activePlanSummary: row.activePlanSummary,
    interest: row.interest,
    riskLevel: row.riskLevel,
    riskScore: row.riskScore,
    riskReasons: row.riskReasons,
    suggestedActions: row.suggestedActions,
    lastReminderAt: row.lastReminderAt,
    remindersCount: row.remindersCount,
    overdueInstallmentsCount: row.overdueInstallmentsCount,
  };
}

async function getDelinquentOwners(organizationId, filters = {}) {
  const page = Math.max(parseInt(filters.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(filters.limit || '20', 10), 1), 100);
  const allRows = await buildDelinquencyRows(organizationId);
  const filtered = sortRows(applyFilters(allRows, filters), filters.sort);
  const total = filtered.length;
  const rows = filtered.slice((page - 1) * limit, page * limit).map(publicOwnerRow);
  return {
    owners: rows,
    filters,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
  };
}

async function getOrganizationDelinquencySummary(organizationId, filters = {}) {
  const rows = applyFilters(await buildDelinquencyRows(organizationId), filters);
  const totalOwners = rows.length;
  const debtors = rows.filter(row => row.totalOwed > 0);
  const totalDebt = debtors.reduce((sum, row) => sum + row.totalOwed, 0);
  const pendingPaymentsCount = rows.reduce((sum, row) => sum + row.pendingPaymentsCount, 0);
  const pendingPaymentsAmount = rows.reduce((sum, row) => sum + row.pendingPaymentsAmount, 0);
  const oldest = debtors
    .map(row => row.oldestPeriod)
    .filter(Boolean)
    .sort()[0] || null;
  return {
    totalDebt,
    delinquentOwners: debtors.length,
    delinquentUnits: new Set(debtors.flatMap(row => row.units.map(unit => oid(unit))).filter(Boolean)).size,
    averageDebt: debtors.length ? Math.round((totalDebt / debtors.length) * 100) / 100 : 0,
    oldestDebtPeriod: oldest,
    delinquencyRate: totalOwners ? Math.round((debtors.length / totalOwners) * 100) : 0,
    pendingPaymentsCount,
    pendingPaymentsAmount,
    totalOwners,
    criticalOwners: debtors.filter(row => row.status === 'mora_critica').length,
    currency: 'ARS',
    interestPreview: {
      interestEnabled: false,
      calculatedInterest: 0,
      debtWithoutInterest: totalDebt,
      debtWithInterest: totalDebt,
    },
  };
}

async function getOwnerDebtDetail(organizationId, ownerId) {
  if (!mongoose.Types.ObjectId.isValid(ownerId)) return null;
  const rows = await buildDelinquencyRows(organizationId);
  const row = rows.find(item => item.id.toString() === ownerId.toString());
  if (!row) return null;
  return {
    owner: {
      id: row.id,
      _id: row._id,
      name: row.name,
      email: row.email,
      phone: row.phone,
    },
    organization: organizationId,
    units: row.units,
    summary: publicOwnerRow(row),
    periodDetails: row.unpaidPeriodDetails.map(item => ({
      period: item.period,
      dueDate: item.dueDate,
      dueDateLabel: item.dueDateLabel,
      concept: 'Expensa mensual',
      originalAmount: item.amount,
      paid: 0,
      balance: item.amount,
      status: item.isOverdue ? 'vencido' : 'pendiente',
      daysOverdue: item.daysOverdue,
      units: item.units,
    })),
    balanceItems: row.balanceUnits.map(item => ({
      period: null,
      dueDate: null,
      concept: `Saldo anterior ${item.name || ''}`.trim(),
      originalAmount: item.amount,
      paid: 0,
      balance: item.amount,
      status: 'pendiente',
      daysOverdue: 0,
      unit: item,
    })),
    extraordinaryItems: row.extraordinaryOwed.map(item => ({
      period: item.period,
      dueDate: item.dueDate,
      concept: item.title,
      originalAmount: item.amount,
      paid: 0,
      balance: item.amount,
      status: item.isOverdue ? 'vencido' : 'pendiente',
      daysOverdue: item.daysOverdue,
    })),
    debtItems: row.debtItems.map(item => ({
      period: item.period,
      dueDate: item.dueDate,
      concept: item.description,
      originalAmount: item.amount,
      paid: 0,
      balance: item.amount,
      status: item.isOverdue ? 'vencido' : 'pendiente',
      daysOverdue: item.daysOverdue,
      type: item.type,
    })),
    payments: {
      approved: row.approvedPayments,
      pending: row.pendingPayments,
      rejected: row.rejectedPayments,
      lastPayment: row.lastPayment,
    },
    observations: [
      row.hasActivePlan ? 'Tiene un plan de pagos activo; los conceptos incluidos se excluyen de la deuda exigible.' : null,
      row.startBillingPeriod ? `Inicio de cobro: ${row.startBillingPeriod}` : null,
    ].filter(Boolean),
  };
}

async function calculateDebtForOwner(organizationId, ownerId) {
  const detail = await getOwnerDebtDetail(organizationId, ownerId);
  return detail?.summary || null;
}

async function getDebtAgingBuckets(organizationId, filters = {}) {
  const rows = applyFilters(await buildDelinquencyRows(organizationId), filters).filter(row => row.totalOwed > 0);
  const buckets = [
    { key: '0-30', label: '0-30 días', min: 0, max: 30, owners: 0, amount: 0 },
    { key: '31-60', label: '31-60 días', min: 31, max: 60, owners: 0, amount: 0 },
    { key: '61-90', label: '61-90 días', min: 61, max: 90, owners: 0, amount: 0 },
    { key: '90+', label: '+90 días', min: 91, max: Infinity, owners: 0, amount: 0 },
  ];
  rows.forEach(row => {
    const bucket = buckets.find(item => row.daysOverdue >= item.min && row.daysOverdue <= item.max) || buckets[0];
    bucket.owners += 1;
    bucket.amount += row.totalOwed;
  });
  return buckets.map(({ min, max, ...bucket }) => bucket);
}

function defaultReminderMessage(ownerDebt) {
  const periods = ownerDebt.unpaidPeriods?.length ? ownerDebt.unpaidPeriods.join(', ') : 'saldo pendiente';
  return `Hola ${ownerDebt.name},\nTe informamos que registrás una deuda pendiente de $ ${Number(ownerDebt.totalOwed || 0).toLocaleString('es-AR')} correspondiente a ${periods}.\nPodés consultar el detalle y regularizar tu situación desde GestionAr.\n\nMuchas gracias.`;
}

async function createDebtReminder({ organizationId, ownerId, userId, channel = 'app', message }) {
  const ownerDebt = await calculateDebtForOwner(organizationId, ownerId);
  if (!ownerDebt) return null;
  if (ownerDebt.totalOwed <= 0) {
    const err = new Error('El propietario no registra deuda exigible.');
    err.statusCode = 400;
    throw err;
  }
  const cleanChannel = ['app', 'manual'].includes(channel) ? channel : 'manual';
  const finalMessage = String(message || defaultReminderMessage(ownerDebt)).trim();
  if (!finalMessage) {
    const err = new Error('El mensaje del recordatorio es obligatorio.');
    err.statusCode = 400;
    throw err;
  }

  let notice = null;
  let status = cleanChannel === 'manual' ? 'logged' : 'sent';
  if (cleanChannel === 'app') {
    notice = await createCommunication({
      organizationId,
      userId,
      body: {
        title: 'Recordatorio de deuda pendiente',
        subject: 'Recordatorio de deuda pendiente',
        body: finalMessage,
        category: 'mora',
        priority: 'high',
        status: 'sent',
        targetType: 'specific_users',
        targetFilters: { userIds: [ownerId] },
        channels: { app: true, email: false, push: false, whatsapp: false },
        readTrackingEnabled: true,
      },
      files: [],
    });
  }

  const reminder = await DelinquencyReminder.create({
    organization: organizationId,
    owner: ownerId,
    unit: ownerDebt.unitDetails?.[0]?._id || ownerDebt.unitDetails?.[0]?.id,
    debtAmount: ownerDebt.totalOwed,
    periods: ownerDebt.unpaidPeriods || [],
    channel: cleanChannel,
    message: finalMessage,
    sentBy: userId,
    sentAt: new Date(),
    status,
    notice: notice?._id,
  });
  return { reminder, notice };
}

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows) {
  const header = ['Propietario', 'Unidad/Lote', 'Deuda total', 'Periodos adeudados', 'Periodo mas antiguo', 'Dias de atraso', 'Ultimo pago', 'Estado'];
  const lines = rows.map(row => [
    row.name,
    row.unitNames.join(', '),
    row.totalOwed,
    row.unpaidPeriods.join(', '),
    row.oldestPeriod || '',
    row.daysOverdue,
    row.lastPayment?.createdAt ? new Date(row.lastPayment.createdAt).toISOString().slice(0, 10) : '',
    row.status,
  ].map(csvEscape).join(','));
  return [header.map(csvEscape).join(','), ...lines].join('\r\n');
}

async function exportDelinquencyCsv(organizationId, filters = {}, ownerId = null) {
  let rows = sortRows(applyFilters(await buildDelinquencyRows(organizationId), filters), filters.sort);
  if (ownerId) rows = rows.filter(row => row.id.toString() === ownerId.toString());
  return rowsToCsv(rows);
}

module.exports = {
  applyFilters,
  buildDelinquencyRows,
  calculateDebtForOwner,
  dueInfoForPeriod,
  exportDelinquencyCsv,
  getDebtAgingBuckets,
  getDelinquentOwners,
  getOwnerDebtDetail,
  getOrganizationDelinquencySummary,
  createDebtReminder,
};
