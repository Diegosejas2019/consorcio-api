const Salary = require('../models/Salary');
const SalaryPayment = require('../models/SalaryPayment');
const Expense = require('../models/Expense');

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getPaidAmountFallback(salary) {
  if (salary.paidAmount !== undefined && salary.paidAmount !== null && !salary.$isDefault?.('paidAmount')) {
    return round2(salary.paidAmount);
  }
  return salary.status === 'paid' ? round2(salary.totalAmount) : 0;
}

function getRemainingAmountFallback(salary) {
  if (salary.remainingAmount !== undefined && salary.remainingAmount !== null && !salary.$isDefault?.('remainingAmount')) {
    return round2(salary.remainingAmount);
  }
  const paidAmount = getPaidAmountFallback(salary);
  return salary.status === 'paid' ? 0 : Math.max(round2(salary.totalAmount) - paidAmount, 0);
}

async function getActiveSalaryPaidAmount(salaryId) {
  const agg = await SalaryPayment.aggregate([
    { $match: { salary: salaryId, isActive: { $ne: false } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  return round2(agg[0]?.total || 0);
}

async function syncSalaryExpense(salary, userId) {
  if (!salary.expenseId) return;

  const update = { updatedBy: userId };

  if (salary.status === 'paid') {
    update.status = 'paid';
  } else if (salary.status === 'cancelled') {
    update.isActive = false;
    update.deletedAt = new Date();
    update.deletedBy = userId;
  } else {
    update.status = 'pending';
  }

  await Expense.findByIdAndUpdate(salary.expenseId, { $set: update });
}

async function recalculateSalaryPaymentStatus(salaryId, userId) {
  const salary = await Salary.findById(salaryId);
  if (!salary) {
    const err = new Error('Sueldo no encontrado.');
    err.statusCode = 404;
    throw err;
  }

  if (salary.status === 'cancelled') {
    await syncSalaryExpense(salary, userId);
    return salary;
  }

  const totalAmount = round2(salary.totalAmount);
  const paidAmount = await getActiveSalaryPaidAmount(salary._id);
  const remainingAmount = Math.max(round2(totalAmount - paidAmount), 0);

  salary.paidAmount = paidAmount;
  salary.remainingAmount = remainingAmount;
  salary.updatedBy = userId;

  if (paidAmount === 0) {
    salary.status = 'pending';
    salary.paymentDate = undefined;
  } else if (paidAmount < totalAmount) {
    salary.status = 'partially_paid';
    salary.paymentDate = undefined;
  } else {
    salary.status = 'paid';
    salary.paymentDate = salary.paymentDate || new Date();
  }

  await salary.save();
  await syncSalaryExpense(salary, userId);
  return salary;
}

module.exports = {
  getActiveSalaryPaidAmount,
  getPaidAmountFallback,
  getRemainingAmountFallback,
  recalculateSalaryPaymentStatus,
  round2,
  syncSalaryExpense,
};
