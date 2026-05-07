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

function getChargeablePeriods(membership = {}, org = {}) {
  const startBilling = membership.startBillingPeriod;
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

function computeTotalOwed(membership, approvedPaidMonths, ownerUnits, org) {
  const initialDebt = Math.max(0, -(membership?.balance || 0));
  const ownerFee = calculateOwnerFee(ownerUnits, org);
  const unpaidPeriods = getUnpaidPeriods(membership, approvedPaidMonths, org);
  return initialDebt + unpaidPeriods.length * ownerFee;
}

module.exports = {
  calculateOwnerFee,
  computeTotalOwed,
  getChargeablePeriods,
  getUnpaidPeriods,
  normalizeDebtBalance,
};
