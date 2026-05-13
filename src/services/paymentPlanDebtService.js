const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const OwnerDebtItem = require('../models/OwnerDebtItem');
const Payment = require('../models/Payment');
const PaymentPlan = require('../models/PaymentPlan');
const PaymentPlanInstallment = require('../models/PaymentPlanInstallment');
const Unit = require('../models/Unit');
const User = require('../models/User');
const { calculateExtraordinaryAmountForOwner } = require('./expenseService');
const { currentYYYYMM } = require('../utils/periods');
const {
  calculateUnitFee,
  computeUnitBalanceOwed,
  getPaidMonthsForUnit,
  normalizeDebtBalance,
} = require('../utils/ownerFinance');

const PLAN_BLOCKING_STATUSES = ['requested', 'approved', 'active', 'completed'];
const PLAN_VISIBLE_STATUSES = ['requested', 'approved', 'active', 'defaulted'];

const oid = value => (value?._id || value)?.toString();

function buildBillableUnitsContext(memberships = [], units = []) {
  const allUnits = [...units];
  const unitsByOwner = {};
  units.forEach(unit => {
    if (!unit.owner) return;
    const key = unit.owner.toString();
    (unitsByOwner[key] ||= []).push(unit);
  });

  memberships.forEach(membership => {
    const user = membership.user;
    if (!user) return;
    const ownerId = oid(user);
    if (unitsByOwner[ownerId]?.length) return;
    if (!user.unit && !user.unitId) return;
    const legacyUnit = {
      _id:         user.unitId || user._id,
      name:        user.unit || 'Unidad',
      owner:       user._id,
      coefficient: membership.percentage > 0 ? membership.percentage : 1,
      active:      true,
      legacy:      true,
    };
    unitsByOwner[ownerId] = [legacyUnit];
    allUnits.push(legacyUnit);
  });

  return { allUnits, unitsByOwner };
}

function normalizePlanDebt(plan = {}) {
  const snapshot = plan.debtSnapshot || {};
  const periods = (snapshot.periods?.length ? snapshot.periods : plan.includedPeriods || [])
    .map(item => ({
      month: item.month,
      amount: Number(item.amount ?? item.originalAmount ?? 0),
    }))
    .filter(item => item.month);

  const extraordinaryItems = (snapshot.extraordinaryItems?.length ? snapshot.extraordinaryItems : plan.extraordinaryItems || [])
    .map(item => ({
      expenseId: oid(item.expenseId || item.expense),
      title: item.title,
      amount: Number(item.amount || 0),
    }))
    .filter(item => item.expenseId);

  const balanceItems = (snapshot.balanceItems || [])
    .map(item => ({
      unit: oid(item.unit),
      name: item.name,
      amount: Number(item.amount || 0),
    }))
    .filter(item => item.amount > 0);

  if (!balanceItems.length && Number(plan.balanceDebt || 0) > 0) {
    balanceItems.push({ unit: null, name: 'Saldo anterior', amount: Number(plan.balanceDebt || 0) });
  }

  const debtItems = (snapshot.debtItems || [])
    .map(item => ({
      debtItem: oid(item.debtItem),
      type: item.type,
      description: item.description,
      amount: Number(item.amount || 0),
      currency: item.currency || 'ARS',
    }))
    .filter(item => item.debtItem);

  const originalDebtAmount = periods.reduce((sum, item) => sum + item.amount, 0)
    + extraordinaryItems.reduce((sum, item) => sum + item.amount, 0)
    + balanceItems.reduce((sum, item) => sum + item.amount, 0)
    + debtItems.reduce((sum, item) => sum + item.amount, 0);

  return {
    periods,
    extraordinaryItems,
    balanceItems,
    debtItems,
    originalDebtAmount: originalDebtAmount || Number(plan.originalDebtAmount || 0),
  };
}

async function getPlanSummariesByOwner({ organizationId, ownerIds, statuses = PLAN_VISIBLE_STATUSES }) {
  const ids = (ownerIds || []).map(id => new mongoose.Types.ObjectId(id));
  if (!ids.length) return {};

  const plans = await PaymentPlan.find({
    organization: organizationId,
    owner: { $in: ids },
    status: { $in: statuses },
    isActive: true,
  }).lean();
  if (!plans.length) return {};

  const installments = await PaymentPlanInstallment.find({
    paymentPlan: { $in: plans.map(plan => plan._id) },
  }).lean();
  const installmentsByPlan = {};
  installments.forEach(item => {
    const key = item.paymentPlan.toString();
    (installmentsByPlan[key] ||= []).push(item);
  });

  const byOwner = {};
  plans.forEach(plan => {
    const debt = normalizePlanDebt(plan);
    const planInstallments = installmentsByPlan[plan._id.toString()] || [];
    const totalPaid = planInstallments
      .filter(item => item.status === 'paid')
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const remainingBalance = Math.max(0, Number(plan.totalAmount || debt.originalDebtAmount || 0) - totalPaid);
    const pending = planInstallments
      .filter(item => ['pending', 'overdue'].includes(item.status))
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    const ownerId = plan.owner.toString();

    const summary = byOwner[ownerId] ||= {
      plans: [],
      blockedMonths: new Set(),
      blockedExtraIds: new Set(),
      blockedDebtItemIds: new Set(),
      plannedBalanceByUnit: {},
      plannedBalanceAmount: 0,
      plannedDebtAmount: 0,
      excludedDebtAmount: 0,
      activePlanSummary: null,
    };

    if (PLAN_BLOCKING_STATUSES.includes(plan.status)) {
      debt.periods.forEach(item => summary.blockedMonths.add(item.month));
      debt.extraordinaryItems.forEach(item => summary.blockedExtraIds.add(item.expenseId));
      debt.debtItems.forEach(item => summary.blockedDebtItemIds.add(item.debtItem));
      debt.balanceItems.forEach(item => {
        summary.plannedBalanceAmount += item.amount;
        if (item.unit) summary.plannedBalanceByUnit[item.unit] = (summary.plannedBalanceByUnit[item.unit] || 0) + item.amount;
      });
      summary.excludedDebtAmount += debt.originalDebtAmount;
    }

    if (PLAN_VISIBLE_STATUSES.includes(plan.status)) {
      summary.plannedDebtAmount += remainingBalance;
      const activeSummary = {
        _id: plan._id,
        status: plan.status,
        statusLabel: plan.statusLabel,
        originalDebtAmount: debt.originalDebtAmount,
        totalAmount: Number(plan.totalAmount || debt.originalDebtAmount || 0),
        totalPaid,
        remainingBalance,
        nextDueDate: pending[0]?.dueDate || null,
        nextDueAmount: pending[0]?.amount || null,
      };
      if (!summary.activePlanSummary || remainingBalance > summary.activePlanSummary.remainingBalance) {
        summary.activePlanSummary = activeSummary;
      }
    }

    summary.plans.push({ plan, debt, totalPaid, remainingBalance });
  });

  Object.values(byOwner).forEach(summary => {
    summary.blockedMonths = [...summary.blockedMonths];
    summary.blockedExtraIds = [...summary.blockedExtraIds];
    summary.blockedDebtItemIds = [...summary.blockedDebtItemIds];
  });

  return byOwner;
}

async function getOwnerDebtOptions({ organizationId, ownerId, excludePlanId = null }) {
  let membership = await OrganizationMember.findOne({
    user: ownerId,
    organization: organizationId,
    role: 'owner',
    isActive: true,
  });

  const [owner, org, activePayments, rawOwnerUnits, rawOrgUnits, memberships, plans, debtItems] = await Promise.all([
    User.findById(ownerId).select('name email unit unitId startBillingPeriod'),
    Organization.findById(organizationId).select('paymentPeriods feePeriodCode monthlyFee'),
    Payment.find({
      organization: organizationId,
      owner: ownerId,
      status: { $in: ['pending', 'approved'] },
    }).select('month extraordinaryItems units status'),
    Unit.find({ owner: ownerId, organization: organizationId, active: true }).lean(),
    Unit.find({ organization: organizationId, active: true }).lean(),
    OrganizationMember.find({ organization: organizationId, role: 'owner', isActive: true })
      .select('user percentage')
      .populate('user', 'unit unitId')
      .lean(),
    PaymentPlan.find({
      organization: organizationId,
      owner: ownerId,
      status: { $in: PLAN_BLOCKING_STATUSES },
      isActive: true,
      ...(excludePlanId ? { _id: { $ne: excludePlanId } } : {}),
    }).lean(),
    OwnerDebtItem.find({
      organization: organizationId,
      owner: ownerId,
      isActive: { $ne: false },
      status: 'pending',
    }).lean(),
  ]);
  if (!owner) return null;
  if (!membership) {
    membership = {
      user: owner._id,
      organization: organizationId,
      role: 'owner',
      isActive: true,
      percentage: 1,
      startBillingPeriod: owner.startBillingPeriod,
    };
  }

  const { allUnits: allOrgUnits, unitsByOwner } = buildBillableUnitsContext(memberships, rawOrgUnits);
  let ownerUnits = unitsByOwner[owner._id.toString()] || rawOwnerUnits;
  if (!ownerUnits.length && (owner.unit || owner.unitId)) {
    ownerUnits = [{
      _id: owner.unitId || owner._id,
      name: owner.unit || 'Unidad',
      owner: owner._id,
      coefficient: membership?.percentage > 0 ? membership.percentage : 1,
      active: true,
      legacy: true,
    }];
  }

  const paidExtraIds = new Set(
    activePayments.flatMap(p => (p.extraordinaryItems || [])
      .map(e => e.expense?.toString())
      .filter(Boolean))
  );

  const blocking = {
    months: new Set(),
    extras: new Set(),
    debtItems: new Set(),
    balanceByUnit: {},
    legacyBalance: 0,
  };
  plans.forEach(plan => {
    const debt = normalizePlanDebt(plan);
    debt.periods.forEach(item => blocking.months.add(item.month));
    debt.extraordinaryItems.forEach(item => blocking.extras.add(item.expenseId));
    debt.debtItems.forEach(item => blocking.debtItems.add(item.debtItem));
    debt.balanceItems.forEach(item => {
      if (item.unit) blocking.balanceByUnit[item.unit] = (blocking.balanceByUnit[item.unit] || 0) + item.amount;
      else blocking.legacyBalance += item.amount;
    });
  });

  const currentPeriod = currentYYYYMM();
  const periodItems = [...new Set(ownerUnits.flatMap(unit => {
    const paidMonths = getPaidMonthsForUnit(unit, activePayments, ['pending', 'approved']);
    const startBilling = unit.startBillingPeriod || membership?.startBillingPeriod || owner.startBillingPeriod;
    return (org?.paymentPeriods || [])
      .filter(p => !paidMonths.has(p) && !blocking.months.has(p) && (!startBilling || p >= startBilling) && p <= currentPeriod);
  }))].sort().map(month => ({
    month,
    amount: ownerUnits.reduce((sum, unit) => sum + calculateUnitFee(unit, org || {}), 0),
  }));

  const extras = await Expense.find({
    organization: organizationId,
    expenseType: 'extraordinary',
    isChargeable: true,
    isActive: { $ne: false },
  }).select('_id description amount date extraordinaryBillingMode unitAmount appliesToAllOwners targetUnits')
    .sort({ date: -1, createdAt: -1 })
    .lean();

  const extraordinary = extras
    .filter(e => !paidExtraIds.has(e._id.toString()) && !blocking.extras.has(e._id.toString()))
    .map(e => {
      const { amountForOwner } = calculateExtraordinaryAmountForOwner(e, ownerUnits, allOrgUnits);
      if (amountForOwner === 0 && ['per_unit', 'by_coefficient'].includes(e.extraordinaryBillingMode)) return null;
      return {
        id: e._id,
        _id: e._id,
        title: e.description,
        description: e.description,
        amount: amountForOwner,
        extraordinaryBillingMode: e.extraordinaryBillingMode || 'fixed_total',
        period: e.date ? e.date.toISOString().slice(0, 7) : null,
        date: e.date,
      };
    })
    .filter(Boolean);

  let legacyBalanceRemaining = blocking.legacyBalance;
  const balanceUnits = ownerUnits.map(unit => {
    const rawOwed = computeUnitBalanceOwed(unit);
    const unitId = oid(unit._id || unit.id);
    const unitPlanned = blocking.balanceByUnit[unitId] || 0;
    const legacyApplied = Math.min(Math.max(0, rawOwed - unitPlanned), legacyBalanceRemaining);
    legacyBalanceRemaining -= legacyApplied;
    const amount = Math.max(0, rawOwed - unitPlanned - legacyApplied);
    return {
      id: unit._id,
      _id: unit._id,
      name: unit.name || 'Unidad',
      amount,
      balance: normalizeDebtBalance(unit.balance),
    };
  }).filter(item => item.amount > 0);

  const availableDebtItems = debtItems
    .filter(item => !blocking.debtItems.has(item._id.toString()))
    .map(item => ({
      id: item._id,
      _id: item._id,
      type: item.type,
      description: item.description,
      amount: Number(item.amount || 0),
      currency: item.currency || 'ARS',
      dueDate: item.dueDate,
      originDate: item.originDate,
    }));

  return {
    owner,
    membership,
    org,
    ownerUnits,
    periods: periodItems.map(item => item.month),
    periodItems,
    extraordinary,
    balanceDebt: balanceUnits.reduce((sum, item) => sum + item.amount, 0),
    balanceUnits,
    debtItems: availableDebtItems,
  };
}

async function buildPlanDebtSnapshot({ organizationId, ownerId, selection = {}, excludePlanId = null }) {
  const options = await getOwnerDebtOptions({ organizationId, ownerId, excludePlanId });
  if (!options) return null;

  const selectedMonths = new Set((selection.includedPeriods || selection.periods || [])
    .map(item => item.month || item)
    .filter(Boolean));
  const selectedExtraIds = new Set((selection.extraordinaryItems || selection.extraordinaryIds || [])
    .map(item => oid(item.expenseId || item.id || item._id || item))
    .filter(Boolean));
  const selectedDebtItemIds = new Set((selection.debtItems || selection.debtItemIds || [])
    .map(item => oid(item.debtItem || item.id || item._id || item))
    .filter(Boolean));
  const selectedBalanceUnitIds = new Set((selection.balanceItems || selection.balanceUnitIds || [])
    .map(item => oid(item.unit || item.id || item._id || item))
    .filter(Boolean));
  const wantsBalance = Number(selection.balanceDebt || selection.balanceAmount || 0) > 0
    || selectedBalanceUnitIds.size > 0
    || selection.includeBalance === true;

  const periodItems = options.periodItems.filter(item => selectedMonths.has(item.month));
  const extraordinaryItems = options.extraordinary
    .filter(item => selectedExtraIds.has(oid(item._id || item.id)))
    .map(item => ({
      expenseId: item._id || item.id,
      title: item.title,
      amount: Number(item.amount || 0),
    }));
  const balanceItems = wantsBalance
    ? options.balanceUnits
      .filter(item => selectedBalanceUnitIds.size === 0 || selectedBalanceUnitIds.has(oid(item._id || item.id)))
      .map(item => ({ unit: item._id || item.id, name: item.name, amount: Number(item.amount || 0) }))
    : [];
  const debtItems = options.debtItems
    .filter(item => selectedDebtItemIds.has(oid(item._id || item.id)))
    .map(item => ({
      debtItem: item._id || item.id,
      type: item.type,
      description: item.description,
      amount: Number(item.amount || 0),
      currency: item.currency || 'ARS',
    }));

  const originalDebtAmount = periodItems.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    + extraordinaryItems.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    + balanceItems.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    + debtItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  return {
    options,
    originalDebtAmount,
    includedPeriods: periodItems.map(item => ({ month: item.month, originalAmount: Number(item.amount || 0) })),
    extraordinaryItems,
    balanceDebt: balanceItems.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    debtSnapshot: {
      periods: periodItems.map(item => ({ month: item.month, amount: Number(item.amount || 0) })),
      extraordinaryItems,
      balanceItems,
      debtItems,
    },
  };
}

async function markDebtItemsIncluded(debtSnapshot = {}) {
  const ids = (debtSnapshot.debtItems || []).map(item => item.debtItem).filter(Boolean);
  if (!ids.length) return;
  await OwnerDebtItem.updateMany(
    { _id: { $in: ids }, status: 'pending' },
    { $set: { status: 'includedInPaymentPlan' } }
  );
}

async function releaseDebtItemsFromPlan(plan) {
  const debt = normalizePlanDebt(plan);
  const ids = debt.debtItems.map(item => item.debtItem).filter(Boolean);
  if (!ids.length) return;
  await OwnerDebtItem.updateMany(
    { _id: { $in: ids }, status: 'includedInPaymentPlan' },
    { $set: { status: 'pending' } }
  );
}

module.exports = {
  PLAN_BLOCKING_STATUSES,
  PLAN_VISIBLE_STATUSES,
  buildBillableUnitsContext,
  buildPlanDebtSnapshot,
  getOwnerDebtOptions,
  getPlanSummariesByOwner,
  markDebtItemsIncluded,
  normalizePlanDebt,
  releaseDebtItemsFromPlan,
};
