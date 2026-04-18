const Payment  = require('../models/Payment');
const Expense  = require('../models/Expense');
const logger   = require('../config/logger');

const CATEGORIES = ['cleaning', 'security', 'maintenance', 'utilities', 'administration', 'other'];

// GET /api/reports/monthly-summary?month=YYYY-MM
exports.getMonthlySummary = async (req, res, next) => {
  try {
    const { month } = req.query;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({
        success: false,
        message: 'Parámetro month inválido. Formato esperado: YYYY-MM',
      });
    }

    const orgId = req.orgId;
    const [year, mon] = month.split('-').map(Number);
    const monthStart  = new Date(year, mon - 1, 1);
    const monthEnd    = new Date(year, mon, 0, 23, 59, 59, 999);

    logger.debug(`[reportController] monthly-summary org=${orgId} month=${month}`);

    const [incomeAgg, expensesAgg, prevIncomeAgg, prevExpensesAgg] = await Promise.all([
      // Ingresos: pagos aprobados del mes
      Payment.aggregate([
        { $match: { organization: orgId, status: 'approved', month } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      // Egresos: gastos pagados del mes, agrupados por categoría
      Expense.aggregate([
        { $match: { organization: orgId, status: 'paid', date: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
      ]),
      // Ingresos anteriores: pagos aprobados ANTES del mes (para saldo anterior)
      Payment.aggregate([
        { $match: { organization: orgId, status: 'approved', month: { $lt: month } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      // Egresos anteriores: gastos pagados ANTES del mes (para saldo anterior)
      Expense.aggregate([
        { $match: { organization: orgId, status: 'paid', date: { $lt: monthStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const income        = incomeAgg[0]?.total        || 0;
    const saldoAnterior = (prevIncomeAgg[0]?.total   || 0) - (prevExpensesAgg[0]?.total || 0);

    // Construir mapa de egresos por categoría
    const expMap    = Object.fromEntries(expensesAgg.map(e => [e._id, e.total]));
    const expenses  = Object.fromEntries(CATEGORIES.map(c => [c, expMap[c] || 0]));
    const expTotal  = CATEGORIES.reduce((sum, c) => sum + expenses[c], 0);

    res.json({
      success: true,
      data: {
        month,
        saldoAnterior,
        income:   { expensas: income, total: income },
        expenses: { ...expenses, total: expTotal },
        balance:  saldoAnterior + income - expTotal,
      },
    });
  } catch (err) {
    next(err);
  }
};
