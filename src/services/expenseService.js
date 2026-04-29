/**
 * Calcula el monto que corresponde pagar a un owner por un gasto extraordinario cobrable,
 * según el modo de cobro configurado en el gasto.
 *
 * @param {Object} expense        - Documento Expense (o lean object) con los campos de billing.
 * @param {Array}  ownerUnits     - Unidades activas del owner en la org.
 * @param {Array}  allOrgUnits    - Todas las unidades activas de la org.
 * @returns {{ amountForOwner: number, breakdown: Array }}
 */
exports.calculateExtraordinaryAmountForOwner = (expense, ownerUnits, allOrgUnits) => {
  const mode = expense.extraordinaryBillingMode || 'fixed_total';

  // Filtrar por targetUnits si el gasto no aplica a todos
  let applicableOwner = ownerUnits;
  let applicableAll   = allOrgUnits;
  if (expense.appliesToAllOwners === false && expense.targetUnits?.length) {
    const targetSet  = new Set(expense.targetUnits.map(id => id.toString()));
    applicableOwner  = ownerUnits.filter(u => targetSet.has(u._id.toString()));
    applicableAll    = allOrgUnits.filter(u => targetSet.has(u._id.toString()));
  }

  if (mode === 'fixed_total') {
    if (applicableOwner.length === 0) {
      // Backward compat: owner sin unidades ve el monto total completo
      return { amountForOwner: expense.amount, breakdown: [] };
    }
    const totalUnits   = applicableAll.length || 1;
    const amountPerUnit = round2(expense.amount / totalUnits);
    return {
      amountForOwner: round2(amountPerUnit * applicableOwner.length),
      breakdown: applicableOwner.map(u => ({ unit: u._id, name: u.name, amount: amountPerUnit })),
    };
  }

  if (mode === 'per_unit') {
    if (applicableOwner.length === 0) return { amountForOwner: 0, breakdown: [] };
    const amountPerUnit = expense.unitAmount || 0;
    return {
      amountForOwner: round2(amountPerUnit * applicableOwner.length),
      breakdown: applicableOwner.map(u => ({ unit: u._id, name: u.name, amount: amountPerUnit })),
    };
  }

  if (mode === 'by_coefficient') {
    if (applicableOwner.length === 0) return { amountForOwner: 0, breakdown: [] };
    const totalCoeff = applicableAll.reduce((s, u) => s + (u.coefficient || 1), 0) || 1;
    let amountForOwner = 0;
    const breakdown = applicableOwner.map(u => {
      const share = round2(expense.amount * ((u.coefficient || 1) / totalCoeff));
      amountForOwner += share;
      return { unit: u._id, name: u.name, amount: share };
    });
    return { amountForOwner: round2(amountForOwner), breakdown };
  }

  return { amountForOwner: expense.amount, breakdown: [] };
};

const round2 = (n) => Math.round(n * 100) / 100;
