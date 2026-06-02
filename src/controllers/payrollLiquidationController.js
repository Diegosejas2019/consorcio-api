const crypto = require('crypto');
const PayrollLiquidation = require('../models/PayrollLiquidation');
const EmployeePayrollProfile = require('../models/EmployeePayrollProfile');
const PayrollSetting = require('../models/PayrollSetting');
const Employee = require('../models/Employee');
const Expense  = require('../models/Expense');
const Salary   = require('../models/Salary');
const SalaryPayment = require('../models/SalaryPayment');
const { calculateMonthly } = require('../services/payrollCalculationService');
const { calculateExternal } = require('../services/payrollApiClient');
const { generateReceiptPdf } = require('../services/payrollReceiptService');
const logger = require('../config/logger');

const EDITABLE_STATUSES = ['draft', 'calculated'];

function round2(n) { return Math.round(n * 100) / 100; }

function recalcTotals(items) {
  const grossRemunerative       = round2(items.filter(i => i.type === 'remunerative').reduce((s, i) => s + i.amount, 0));
  const grossNonRemunerative    = round2(items.filter(i => i.type === 'non_remunerative').reduce((s, i) => s + i.amount, 0));
  const deductionsTotal         = round2(items.filter(i => i.type === 'deduction').reduce((s, i) => s + i.amount, 0));
  const employerContributionsTotal = round2(items.filter(i => i.type === 'employer_contribution').reduce((s, i) => s + i.amount, 0));
  const netPay = round2(grossRemunerative + grossNonRemunerative - deductionsTotal);
  return { grossRemunerative, grossNonRemunerative, deductionsTotal, employerContributionsTotal, netPay };
}

// Serializa liquidación según nivel de permiso del usuario
function serializeLiquidation(liq, isReadOnly = false) {
  const obj = liq.toObject ? liq.toObject({ virtuals: true }) : { ...liq };
  if (isReadOnly) {
    delete obj.itemsSnapshot;
    // cuil y cbu no existen en liquidación, pero por si se popula el perfil
    if (obj.employeeProfile) {
      delete obj.employeeProfile.cuil;
      delete obj.employeeProfile.cbu;
    }
  }
  return obj;
}

// GET /api/payroll/liquidations
exports.getLiquidations = async (req, res, next) => {
  try {
    const { period, employeeId, status, liquidationType, page = 1, limit = 50 } = req.query;
    const filter = { organization: req.orgId };
    if (period)          filter.period = period;
    if (employeeId)      filter.employee = employeeId;
    if (status)          filter.status = status;
    if (liquidationType) filter.liquidationType = liquidationType;

    const isReadOnly = req.membership?.adminRole === 'read_only';

    const selectFields = isReadOnly
      ? '-__v -itemsSnapshot'
      : '-__v';

    const liquidations = await PayrollLiquidation.find(filter)
      .populate('employee', 'name role customRole isActive')
      .sort({ period: -1, createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .select(selectFields);

    const total = await PayrollLiquidation.countDocuments(filter);

    res.json({
      success: true,
      data: { liquidations },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/payroll/liquidations/:id
exports.getLiquidation = async (req, res, next) => {
  try {
    const isReadOnly = req.membership?.adminRole === 'read_only';
    const selectFields = isReadOnly ? '-__v -itemsSnapshot' : '-__v';

    const liquidation = await PayrollLiquidation.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('employee', 'name role customRole isActive')
      .select(selectFields);

    if (!liquidation) return res.status(404).json({ success: false, message: 'Liquidación no encontrada.' });
    res.json({ success: true, data: { liquidation } });
  } catch (err) {
    next(err);
  }
};

// POST /api/payroll/liquidations — crea borrador
exports.createDraft = async (req, res, next) => {
  try {
    const { employeeId, period, liquidationType = 'monthly', notes } = req.body;

    if (!employeeId || !period) {
      return res.status(400).json({ success: false, message: 'Empleado y período son obligatorios.' });
    }

    // Verificar configuración de empleador
    const setting = await PayrollSetting.findOne({ organization: req.orgId, active: true });
    if (!setting) {
      return res.status(400).json({ success: false, message: 'La organización no tiene configuración de empleador completa.' });
    }

    // Verificar perfil laboral
    const profile = await EmployeePayrollProfile.findOne({ organization: req.orgId, employee: employeeId, active: true })
      .select('+cuil +cbu');
    if (!profile) {
      return res.status(400).json({ success: false, message: 'El empleado no tiene perfil laboral completo para liquidación legal.' });
    }

    const employee = await Employee.findOne({ _id: employeeId, organization: req.orgId });
    if (!employee) return res.status(400).json({ success: false, message: 'Empleado no válido.' });
    if (!employee.isActive) return res.status(400).json({ success: false, message: 'No se puede liquidar un empleado dado de baja.' });

    // Chequeo explícito de duplicado (complementa el índice parcial)
    const existing = await PayrollLiquidation.findOne({
      organization: req.orgId, employee: employeeId, period, liquidationType,
      status: { $ne: 'cancelled' },
    });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Ya existe una liquidación de este tipo para el empleado en el período indicado.' });
    }

    // Sugerir adelantos del período
    const advancePayments = await SalaryPayment.find({
      organization: req.orgId,
      employee: employeeId,
      period,
      type: 'advance',
      isActive: true,
    }).select('amount paymentDate note');

    const liquidation = await PayrollLiquidation.create({
      organization: req.orgId,
      employee: employeeId,
      period,
      liquidationType,
      notes,
      createdBy: req.user._id,
    });

    await liquidation.populate('employee', 'name role customRole');
    logger.info(`PayrollLiquidation draft creado: ${employee.name} ${period} ${liquidationType} [org: ${req.orgId}]`);

    res.status(201).json({
      success: true,
      data: {
        liquidation,
        suggestedDeductions: advancePayments.map(a => ({
          source: 'advance',
          code: 'ADELANTO',
          label: 'Adelanto de haberes',
          amount: a.amount,
          date: a.paymentDate,
          note: a.note,
          salaryPaymentId: a._id,
        })),
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Ya existe una liquidación de este tipo para el empleado en el período indicado.' });
    }
    next(err);
  }
};

// POST /api/payroll/liquidations/:id/items — agrega ítem manual
exports.addItem = async (req, res, next) => {
  try {
    const liquidation = await PayrollLiquidation.findOne({ _id: req.params.id, organization: req.orgId });
    if (!liquidation) return res.status(404).json({ success: false, message: 'Liquidación no encontrada.' });
    if (!EDITABLE_STATUSES.includes(liquidation.status)) {
      return res.status(400).json({ success: false, message: 'No se pueden modificar ítems de una liquidación aprobada, pagada o cancelada.' });
    }

    const { code, label, type, quantity = 1, unitValue = 0, amount, formulaSnapshot, legalReference } = req.body;
    if (!code || !label || !type || amount === undefined) {
      return res.status(400).json({ success: false, message: 'code, label, type y amount son obligatorios.' });
    }

    liquidation.itemsSnapshot.push({ code, label, type, quantity, unitValue, amount, formulaSnapshot, legalReference });
    Object.assign(liquidation, recalcTotals(liquidation.itemsSnapshot));
    liquidation.status = 'calculated';
    await liquidation.save();

    res.json({ success: true, data: { liquidation } });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/payroll/liquidations/:id/items/:itemIndex
exports.deleteItem = async (req, res, next) => {
  try {
    const liquidation = await PayrollLiquidation.findOne({ _id: req.params.id, organization: req.orgId });
    if (!liquidation) return res.status(404).json({ success: false, message: 'Liquidación no encontrada.' });
    if (!EDITABLE_STATUSES.includes(liquidation.status)) {
      return res.status(400).json({ success: false, message: 'No se pueden modificar ítems de una liquidación aprobada, pagada o cancelada.' });
    }

    const idx = parseInt(req.params.itemIndex, 10);
    if (isNaN(idx) || idx < 0 || idx >= liquidation.itemsSnapshot.length) {
      return res.status(400).json({ success: false, message: 'Índice de ítem inválido.' });
    }

    liquidation.itemsSnapshot.splice(idx, 1);
    Object.assign(liquidation, recalcTotals(liquidation.itemsSnapshot));
    if (liquidation.itemsSnapshot.length === 0) liquidation.status = 'draft';
    await liquidation.save();

    res.json({ success: true, data: { liquidation } });
  } catch (err) {
    next(err);
  }
};

// POST /api/payroll/liquidations/:id/calculate
exports.calculate = async (req, res, next) => {
  try {
    const liquidation = await PayrollLiquidation.findOne({ _id: req.params.id, organization: req.orgId });
    if (!liquidation) return res.status(404).json({ success: false, message: 'Liquidación no encontrada.' });
    if (!EDITABLE_STATUSES.includes(liquidation.status)) {
      return res.status(400).json({ success: false, message: 'Solo se puede recalcular un borrador o liquidación calculada.' });
    }

    const { calculationProvider = 'internal', news = {} } = req.body;

    const profile = await EmployeePayrollProfile.findOne({ organization: req.orgId, employee: liquidation.employee, active: true })
      .select('+cuil +cbu');
    if (!profile) {
      return res.status(400).json({ success: false, message: 'El empleado no tiene perfil laboral activo.' });
    }

    const setting = await PayrollSetting.findOne({ organization: req.orgId, active: true });
    if (!setting) {
      return res.status(400).json({ success: false, message: 'No hay configuración de empleador activa.' });
    }

    let calcResult;
    try {
      if (calculationProvider === 'payroll-api-argentina') {
        const employee = await Employee.findById(liquidation.employee).lean();
        calcResult = await calculateExternal({
          period: liquidation.period,
          liquidationType: liquidation.liquidationType,
          employer: {
            legalName: setting.employerLegalName,
            cuit: setting.employerCuit,
            address: setting.employerAddress,
            activity: setting.employerActivity,
          },
          employee: {
            externalEmployeeId: liquidation.employee.toString(),
            firstName: (employee.name || '').split(' ')[0],
            lastName: (employee.name || '').split(' ').slice(1).join(' '),
            cuil: profile.cuil,
            category: profile.category,
            convention: profile.convention,
            hireDate: profile.hireDate,
            seniorityDate: profile.seniorityDate,
            employmentType: profile.employmentType,
            workSchedule: profile.workSchedule,
            baseSalary: profile.baseSalary,
          },
          settings: { ruleVersion: req.body.ruleVersion },
          news,
        });
      } else {
        calcResult = await calculateMonthly({ profile, payrollSetting: setting, period: liquidation.period, news });
      }
    } catch (calcErr) {
      logger.error(`payrollCalculation error [${liquidation._id}]: ${calcErr.message}`);
      return res.status(502).json({ success: false, message: `Error al calcular la liquidación: ${calcErr.message}` });
    }

    liquidation.calculationProvider = calculationProvider;
    liquidation.calculationId       = calcResult.calculationId || calcResult.audit?.inputsHash || crypto.randomUUID();
    liquidation.ruleVersion         = calcResult.ruleVersion;
    liquidation.grossRemunerative   = calcResult.grossRemunerative;
    liquidation.grossNonRemunerative = calcResult.grossNonRemunerative;
    liquidation.deductionsTotal     = calcResult.deductionsTotal;
    liquidation.employerContributionsTotal = calcResult.employerContributionsTotal;
    liquidation.netPay              = calcResult.netPay;
    liquidation.itemsSnapshot       = calcResult.itemsSnapshot || calcResult.items || [];
    liquidation.warnings            = calcResult.warnings || [];
    liquidation.status              = 'calculated';
    await liquidation.save();

    res.json({ success: true, data: { liquidation } });
  } catch (err) {
    next(err);
  }
};

// POST /api/payroll/liquidations/:id/approve
exports.approve = async (req, res, next) => {
  try {
    const liquidation = await PayrollLiquidation.findOne({ _id: req.params.id, organization: req.orgId });
    if (!liquidation) return res.status(404).json({ success: false, message: 'Liquidación no encontrada.' });
    if (liquidation.status !== 'calculated') {
      return res.status(400).json({ success: false, message: 'Solo se puede aprobar una liquidación en estado calculado.' });
    }

    // Anti-duplicado: si ya tiene expenseId, no crear otro
    if (liquidation.expenseId) {
      liquidation.status    = 'approved';
      liquidation.approvedBy = req.user._id;
      liquidation.approvedAt = new Date();
      await liquidation.save();
      return res.json({ success: true, data: { liquidation } });
    }

    // Detectar conflicto con Salary existente
    const existingSalary = await Salary.findOne({
      organization: req.orgId,
      employee: liquidation.employee,
      period: liquidation.period,
      expenseId: { $exists: true, $ne: null },
    });

    if (existingSalary && !req.body.confirmDuplicateExpense) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_EXPENSE_WARNING',
        message: 'Ya existe un gasto contable para el sueldo de este empleado en este período (generado desde Salary). Enviá confirmDuplicateExpense: true para crear uno adicional, o linkToSalaryExpense: true para vincular al existente.',
        existingSalaryId: existingSalary._id,
        existingExpenseId: existingSalary.expenseId,
      });
    }

    // Vincular al Expense existente del Salary si se solicita
    if (existingSalary && req.body.linkToSalaryExpense) {
      liquidation.expenseId = existingSalary.expenseId;
      liquidation.salaryRef = existingSalary._id;
    } else {
      // Generar nuevo Expense
      const employee = await Employee.findById(liquidation.employee).lean();
      const expense = await Expense.create({
        organization: req.orgId,
        description:  `Liquidación haberes — ${employee?.name || ''} — ${liquidation.period} — ${liquidation.liquidationType}`,
        category:     'salaries',
        amount:       liquidation.netPay,
        date:         new Date(`${liquidation.period}-01`),
        status:       'pending',
        createdBy:    req.user._id,
      });
      liquidation.expenseId = expense._id;
    }

    liquidation.status     = 'approved';
    liquidation.approvedBy = req.user._id;
    liquidation.approvedAt = new Date();
    await liquidation.save();

    logger.info(`PayrollLiquidation aprobada: ${liquidation._id} neto: ${liquidation.netPay} [org: ${req.orgId}]`);
    res.json({ success: true, data: { liquidation } });
  } catch (err) {
    next(err);
  }
};

// POST /api/payroll/liquidations/:id/cancel
exports.cancel = async (req, res, next) => {
  try {
    const liquidation = await PayrollLiquidation.findOne({ _id: req.params.id, organization: req.orgId });
    if (!liquidation) return res.status(404).json({ success: false, message: 'Liquidación no encontrada.' });
    if (liquidation.status === 'paid') {
      return res.status(400).json({ success: false, message: 'No se puede cancelar una liquidación ya pagada.' });
    }
    if (liquidation.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'La liquidación ya está cancelada.' });
    }

    liquidation.status      = 'cancelled';
    liquidation.cancelledBy = req.user._id;
    liquidation.cancelledAt = new Date();
    await liquidation.save();

    res.json({ success: true, message: 'Liquidación cancelada.' });
  } catch (err) {
    next(err);
  }
};

// POST /api/payroll/liquidations/:id/mark-paid
exports.markPaid = async (req, res, next) => {
  try {
    const liquidation = await PayrollLiquidation.findOne({ _id: req.params.id, organization: req.orgId });
    if (!liquidation) return res.status(404).json({ success: false, message: 'Liquidación no encontrada.' });
    if (liquidation.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Solo se puede marcar como pagada una liquidación aprobada.' });
    }

    liquidation.status = 'paid';
    liquidation.paidAt = new Date();
    await liquidation.save();

    // Marcar el Expense como pagado si está vinculado y es exclusivo
    if (liquidation.expenseId && !liquidation.salaryRef) {
      await Expense.findByIdAndUpdate(liquidation.expenseId, { status: 'paid', paymentDate: new Date() });
    }

    res.json({ success: true, data: { liquidation } });
  } catch (err) {
    next(err);
  }
};

// POST /api/payroll/liquidations/:id/import-advances
exports.importAdvances = async (req, res, next) => {
  try {
    const liquidation = await PayrollLiquidation.findOne({ _id: req.params.id, organization: req.orgId });
    if (!liquidation) return res.status(404).json({ success: false, message: 'Liquidación no encontrada.' });
    if (!EDITABLE_STATUSES.includes(liquidation.status)) {
      return res.status(400).json({ success: false, message: 'No se pueden modificar ítems de una liquidación aprobada, pagada o cancelada.' });
    }

    const { salaryPaymentIds } = req.body;
    if (!Array.isArray(salaryPaymentIds) || salaryPaymentIds.length === 0) {
      return res.status(400).json({ success: false, message: 'salaryPaymentIds debe ser un array no vacío.' });
    }

    const advances = await SalaryPayment.find({
      _id: { $in: salaryPaymentIds },
      organization: req.orgId,
      employee: liquidation.employee,
      period: liquidation.period,
      type: 'advance',
      isActive: true,
    });

    if (advances.length === 0) {
      return res.status(400).json({ success: false, message: 'No se encontraron adelantos válidos para importar.' });
    }

    for (const adv of advances) {
      liquidation.itemsSnapshot.push({
        code: 'ADELANTO',
        label: 'Adelanto de haberes',
        type: 'deduction',
        quantity: 1,
        unitValue: adv.amount,
        amount: adv.amount,
        formulaSnapshot: `adelanto ${adv.paymentDate?.toISOString?.()?.split('T')[0] || ''}`,
        legalReference: '',
      });
    }

    Object.assign(liquidation, recalcTotals(liquidation.itemsSnapshot));
    await liquidation.save();

    res.json({ success: true, data: { liquidation, importedCount: advances.length } });
  } catch (err) {
    next(err);
  }
};

// POST /api/payroll/liquidations/:id/receipt-pdf
exports.generateReceipt = async (req, res, next) => {
  try {
    const liquidation = await PayrollLiquidation.findOne({ _id: req.params.id, organization: req.orgId });
    if (!liquidation) return res.status(404).json({ success: false, message: 'Liquidación no encontrada.' });
    if (!['approved', 'paid'].includes(liquidation.status)) {
      return res.status(400).json({ success: false, message: 'Solo se puede generar recibo de liquidaciones aprobadas o pagadas.' });
    }

    const [employee, setting, profile] = await Promise.all([
      Employee.findById(liquidation.employee).lean(),
      PayrollSetting.findOne({ organization: req.orgId }).lean(),
      EmployeePayrollProfile.findOne({ organization: req.orgId, employee: liquidation.employee }).lean(),
    ]);

    // Determinar si es borrador según feature flag
    const OrganizationFeature = require('../models/OrganizationFeature');
    const { buildDefaultFeatureMap } = require('../utils/features');
    const featureRecords = await OrganizationFeature.find({ organization: req.orgId, featureKey: 'legalPayroll' }).lean();
    const features = buildDefaultFeatureMap(featureRecords);
    const isDraft = !features['legalPayroll'];

    const employeeData = {
      ...employee,
      hireDate: profile?.hireDate,
    };

    const { url, publicId } = await generateReceiptPdf({ liquidation, employee: employeeData, setting, isDraft });

    liquidation.receiptPdfUrl      = url;
    liquidation.receiptPdfPublicId = publicId;
    await liquidation.save();

    logger.info(`Recibo PDF generado para liquidación ${liquidation._id} [org: ${req.orgId}]`);
    res.json({ success: true, data: { receiptPdfUrl: url } });
  } catch (err) {
    next(err);
  }
};
