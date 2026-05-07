const { currentYYYYMM } = require('./periods');

function normalizeDebtBalance(raw, fallback = 0) {
  const amount = Number(raw ?? fallback);
  if (!Number.isFinite(amount)) return fallback;
  return amount > 0 ? -amount : amount;
}

function calculateOwnerFee(ownerUnits = [], org = {}) {
  const monthlyFee = org?.monthlyFee || 0;
  return ownerUnits.reduce((sum, unit) => {
    const customFee = unit.customFee;
    if (customFee !== undefined && customFee !== null) return sum + customFee;
    return sum + monthlyFee * (unit.coefficient || 1);
  }, 0);
}

function calculateUnitFee(unit = {}, org = {}) {
  const monthlyFee = org?.monthlyFee || 0;
  const customFee = unit.customFee;
  if (customFee !== undefined && customFee !== null) return Number(customFee || 0);
  return Number(monthlyFee || 0) * Number(unit.coefficient || 1);
}

function getUnitStartBillingPeriod(unit = {}, membership = {}) {
  return unit.startBillingPeriod || membership?.startBillingPeriod;
}

function getChargeablePeriods(membership = {}, org = {}) {
  const startBilling = membership.startBillingPeriod;
  const currentPeriod = currentYYYYMM();
  return (org?.paymentPeriods || [])
    .filter(period => (!startBilling || period >= startBilling) && period <= currentPeriod)
    .sort();
}

function getChargeablePeriodsForUnit(unit = {}, membership = {}, org = {}) {
  const startBilling = getUnitStartBillingPeriod(unit, membership);
  const currentPeriod = currentYYYYMM();
  return (org?.paymentPeriods || [])
    .filter(period => (!startBilling || period >= startBilling) && period <= currentPeriod)
    .sort();
}

function getUnpaidPeriods(membership, approvedPaidMonths, org) {
  const paidMonths = approvedPaidMonths instanceof Set
    ? approvedPaidMonths
    : new Set(approvedPaidMonths || []);
  return getChargeablePeriods(membership, org)
    .filter(period => !paidMonths.has(period));
}

function getPaidMonthsForUnit(unit, ownerPayments = [], statuses = ['approved']) {
  const unitId = (unit?._id || unit)?.toString();
  const allowed = new Set(statuses);
  return new Set(
    (ownerPayments || [])
      .filter(payment => allowed.has(payment.status) && payment.month)
      .filter(payment => {
        const units = payment.units || [];
        // Compatibilidad con pagos antiguos sin snapshot de unidad: cubren las unidades actuales del owner.
        if (!units.length) return true;
        return units.some(id => (id?._id || id)?.toString() === unitId);
      })
      .map(payment => payment.month)
  );
}

function getUnpaidPeriodsForUnit(unit, membership, ownerPayments, org, statuses = ['approved']) {
  const paidMonths = getPaidMonthsForUnit(unit, ownerPayments, statuses);
  return getChargeablePeriodsForUnit(unit, membership, org)
    .filter(period => !paidMonths.has(period));
}

function computeUnitBalanceOwed(unit = {}) {
  return Math.max(0, -normalizeDebtBalance(unit.balance));
}

function computeUnitsBalance(units = []) {
  return units.reduce((sum, unit) => sum + normalizeDebtBalance(unit.balance), 0);
}

function computeUnitsBalanceOwed(units = []) {
  return units.reduce((sum, unit) => sum + computeUnitBalanceOwed(unit), 0);
}

function computeUnitsDebtorFlag(units = []) {
  return units.some(unit => computeUnitBalanceOwed(unit) > 0 || unit.isDebtor === true);
}

function computeTotalOwed(membership, approvedPaidMonths, ownerUnits, org) {
  const initialDebt = Math.max(0, -(membership?.balance || 0));
  const ownerFee = calculateOwnerFee(ownerUnits, org);
  const unpaidPeriods = getUnpaidPeriods(membership, approvedPaidMonths, org);
  return initialDebt + unpaidPeriods.length * ownerFee;
}

function computeTotalOwedByUnits(membership = {}, ownerPayments = [], ownerUnits = [], org = {}) {
  return (ownerUnits || []).reduce((sum, unit) => {
    const balanceOwed = computeUnitBalanceOwed(unit);
    const unpaidPeriods = getUnpaidPeriodsForUnit(unit, membership, ownerPayments, org, ['approved']);
    return sum + balanceOwed + unpaidPeriods.length * calculateUnitFee(unit, org);
  }, 0);
}

function summarizeUnitDebts(units = []) {
  return (units || []).map(unit => ({
    id:           (unit._id || unit.id)?.toString(),
    _id:          unit._id || unit.id,
    name:         unit.name,
    balance:      normalizeDebtBalance(unit.balance),
    balanceOwed:  computeUnitBalanceOwed(unit),
    isDebtor:     computeUnitBalanceOwed(unit) > 0 || unit.isDebtor === true,
  }));
}

module.exports = {
  calculateOwnerFee,
  calculateUnitFee,
  computeTotalOwed,
  computeTotalOwedByUnits,
  computeUnitBalanceOwed,
  computeUnitsBalance,
  computeUnitsBalanceOwed,
  computeUnitsDebtorFlag,
  getChargeablePeriodsForUnit,
  getChargeablePeriods,
  getPaidMonthsForUnit,
  getUnpaidPeriodsForUnit,
  getUnpaidPeriods,
  normalizeDebtBalance,
  summarizeUnitDebts,
};
