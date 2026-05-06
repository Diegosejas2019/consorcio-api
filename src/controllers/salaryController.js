const Salary = require('../models/Salary');
const SalaryPayment = require('../models/SalaryPayment');
const Employee = require('../models/Employee');
const Expense = require('../models/Expense');
const logger = require('../config/logger');
const {
  getActiveSalaryPaidAmount,
  getPaidAmountFallback,
  recalculateSalaryPaymentStatus,
  round2,
  syncSalaryExpense,
} = require('../services/salaryPaymentService');

const ROLE_LABELS = {
  security:    'Seguridad',
  cleaning:    'Limpieza',
  admin:       'Administracion',
  maintenance: 'Mantenimiento',
  other:       'Otro',
};
const VALID_PAYMENT_METHODS = ['cash', 'transfer'];

function buildExpenseDescription(employee, period) {
  const roleLabel = ROLE_LABELS[employee.role] || employee.customRole || employee.role;
  return `Sueldo - ${roleLabel} - ${employee.name} - ${period}`;
}

function salaryToResponse(salary) {
  const obj = salary.toObject ? salary.toObject({ virtuals: true }) : { ...salary };
  const paidWasDefault = salary.$isDefault?.('paidAmount');
  const remainingWasDefault = salary.$isDefault?.('remainingAmount');

  if (paidWasDefault) {
    obj.paidAmount = obj.status === 'paid' ? round2(obj.totalAmount) : 0;
  } else {
    obj.paidAmount = round2(obj.paidAmount);
  }

  if (remainingWasDefault) {
    obj.remainingAmount = obj.status === 'paid'
      ? 0
      : Math.max(round2(obj.totalAmount) - obj.paidAmount, 0);
  } else {
    obj.remainingAmount = round2(obj.remainingAmount);
  }

  return obj;
}

async function getEffectivePaidAmount(salary) {
  const activePaidAmount = await getActiveSalaryPaidAmount(salary._id);
  if (activePaidAmount > 0) return activePaidAmount;
  return getPaidAmountFallback(salary);
}

async function createLegacySalaryPaymentIfNeeded(salary, req, paidAmount) {
  if (salary.status !== 'paid' || paidAmount <= 0) return null;

  const activePaidAmount = await getActiveSalaryPaidAmount(salary._id);
  if (activePaidAmount > 0) return null;

  return SalaryPayment.create({
    organization:  salary.organization,
    salary:        salary._id,
    employee:      salary.employee,
    period:        salary.period,
    type:          'salary_payment',
    amount:        paidAmount,
    paymentDate:   salary.paymentDate || new Date(),
    paymentMethod: req.body.paymentMethod || salary.paymentMethod || 'cash',
    note:          'Pago migrado automaticamente desde un sueldo ya pagado.',
    createdBy:     req.user._id,
  });
}

async function createSalaryPaymentForRemaining(salary, req, paymentDate) {
  const activePaidAmount = await getActiveSalaryPaidAmount(salary._id);
  const remainingAmount = Math.max(round2(salary.totalAmount) - activePaidAmount, 0);

  if (remainingAmount <= 0) return null;

  return SalaryPayment.create({
    organization:  salary.organization,
    salary:        salary._id,
    employee:      salary.employee,
    period:        salary.period,
    type:          'salary_payment',
    amount:        remainingAmount,
    paymentDate:   paymentDate ? new Date(paymentDate) : new Date(),
    paymentMethod: req.body.paymentMethod || salary.paymentMethod || 'cash',
    note:          'Pago registrado al marcar el sueldo como pagado.',
    createdBy:     req.user._id,
  });
}

// GET /api/salaries
exports.getSalaries = async (req, res, next) => {
  try {
    const { period, employeeId, status, search, page = 1, limit = 50 } = req.query;

    const filter = { organization: req.orgId };
    if (period) filter.period = period;
    if (employeeId) filter.employee = employeeId;
    if (status) filter.status = status;

    let salaries = await Salary.find(filter)
      .populate('employee', 'name role customRole isActive')
      .sort({ period: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('-__v');

    if (search) {
      const re = new RegExp(search, 'i');
      salaries = salaries.filter(s => re.test(s.employee?.name));
    }

    const total = await Salary.countDocuments(filter);

    res.json({
      success: true,
      data: { salaries: salaries.map(salaryToResponse) },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/salaries
exports.createSalary = async (req, res, next) => {
  try {
    const {
      employeeId,
      period,
      baseAmount,
      extraAmount = 0,
      deductions = 0,
      notes,
      paymentMethod,
      paymentDate,
      status,
    } = req.body;

    if (!employeeId || !period || baseAmount === undefined) {
      return res.status(400).json({ success: false, message: 'Empleado, periodo y monto base son obligatorios.' });
    }
    if (paymentMethod && !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: 'El metodo de pago no es valido.' });
    }

    const employee = await Employee.findOne({ _id: employeeId, organization: req.orgId });
    if (!employee) return res.status(400).json({ success: false, message: 'Empleado no valido o no pertenece a esta organizacion.' });
    if (!employee.isActive) return res.status(400).json({ success: false, message: 'No se puede liquidar un empleado dado de baja.' });

    const totalAmount = round2(Number(baseAmount) + Number(extraAmount) - Number(deductions));
    if (totalAmount < 0) return res.status(400).json({ success: false, message: 'El total no puede ser negativo.' });

    const expense = await Expense.create({
      organization: req.orgId,
      description:  buildExpenseDescription(employee, period),
      category:     'salaries',
      amount:       totalAmount,
      date:         new Date(`${period}-01`),
      status:       'pending',
      createdBy:    req.user._id,
    });

    let salary = await Salary.create({
      organization:    req.orgId,
      employee:        employeeId,
      period,
      baseAmount:      Number(baseAmount),
      extraAmount:     Number(extraAmount),
      deductions:      Number(deductions),
      totalAmount,
      paidAmount:      0,
      remainingAmount: totalAmount,
      status:          'pending',
      notes,
      paymentMethod,
      expenseId:       expense._id,
      createdBy:       req.user._id,
    });

    if (status === 'paid' && totalAmount > 0) {
      await createSalaryPaymentForRemaining(salary, req, paymentDate);
      salary = await recalculateSalaryPaymentStatus(salary._id, req.user._id);
    }

    await salary.populate('employee', 'name role customRole');

    logger.info(`Sueldo creado: ${employee.name} ${period} $${totalAmount} [org: ${req.orgId}]`);
    res.status(201).json({ success: true, data: { salary: salaryToResponse(salary), expense } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Ya existe un sueldo para este empleado en ese periodo.' });
    }
    next(err);
  }
};

// GET /api/salaries/:id
exports.getSalary = async (req, res, next) => {
  try {
    const salary = await Salary.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('employee', 'name role customRole isActive')
      .populate('expenseId')
      .select('-__v');

    if (!salary) return res.status(404).json({ success: false, message: 'Sueldo no encontrado.' });
    res.json({ success: true, data: { salary: salaryToResponse(salary) } });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/salaries/:id
exports.updateSalary = async (req, res, next) => {
  try {
    let salary = await Salary.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('employee', 'name role customRole');

    if (!salary) return res.status(404).json({ success: false, message: 'Sueldo no encontrado.' });
    if (salary.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'No se puede modificar un sueldo cancelado.' });
    }

    const { baseAmount, extraAmount, deductions, status, paymentDate, paymentMethod, notes } = req.body;

    if (paymentMethod && !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: 'El metodo de pago no es valido.' });
    }

    const newBase = baseAmount !== undefined ? Number(baseAmount) : salary.baseAmount;
    const newExtra = extraAmount !== undefined ? Number(extraAmount) : salary.extraAmount;
    const newDeductions = deductions !== undefined ? Number(deductions) : salary.deductions;
    const newTotal = round2(newBase + newExtra - newDeductions);

    if (newTotal < 0) return res.status(400).json({ success: false, message: 'El total no puede ser negativo.' });

    const paidAmount = await getEffectivePaidAmount(salary);
    if (newTotal < paidAmount) {
      return res.status(400).json({ success: false, message: 'El total del sueldo no puede ser menor al monto ya pagado.' });
    }

    salary.baseAmount = newBase;
    salary.extraAmount = newExtra;
    salary.deductions = newDeductions;
    salary.totalAmount = newTotal;
    salary.paidAmount = paidAmount;
    salary.remainingAmount = Math.max(newTotal - paidAmount, 0);
    salary.updatedBy = req.user._id;
    if (notes !== undefined) salary.notes = notes;
    if (paymentMethod !== undefined) salary.paymentMethod = paymentMethod;

    if (status === 'cancelled') {
      salary.status = 'cancelled';
      salary.paymentDate = undefined;
      await salary.save();
      await syncSalaryExpense(salary, req.user._id);
      logger.info(`Sueldo cancelado: ${salary._id} [org: ${req.orgId}]`);
      return res.json({ success: true, data: { salary: salaryToResponse(salary) } });
    }

    if (salary.expenseId) {
      await Expense.findByIdAndUpdate(salary.expenseId, {
        $set: {
          amount:      newTotal,
          description: buildExpenseDescription(salary.employee, salary.period),
          updatedBy:   req.user._id,
        },
      });
    }

    await salary.save();

    await createLegacySalaryPaymentIfNeeded(salary, req, paidAmount);

    if (status === 'paid') {
      if (salary.status !== 'paid') {
        await createSalaryPaymentForRemaining(salary, req, paymentDate);
      }
      salary = await recalculateSalaryPaymentStatus(salary._id, req.user._id);
    } else {
      salary = await recalculateSalaryPaymentStatus(salary._id, req.user._id);
    }

    await salary.populate('employee', 'name role customRole');

    logger.info(`Sueldo actualizado: ${salary._id} status=${salary.status} [org: ${req.orgId}]`);
    res.json({ success: true, data: { salary: salaryToResponse(salary) } });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/salaries/:id (cancelar)
exports.deleteSalary = async (req, res, next) => {
  try {
    const salary = await Salary.findOne({ _id: req.params.id, organization: req.orgId });
    if (!salary) return res.status(404).json({ success: false, message: 'Sueldo no encontrado.' });
    if (salary.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'El sueldo ya esta cancelado.' });
    }

    salary.status = 'cancelled';
    salary.updatedBy = req.user._id;
    await salary.save();
    await syncSalaryExpense(salary, req.user._id);

    logger.info(`Sueldo cancelado: ${salary._id} [org: ${req.orgId}]`);
    res.json({ success: true, message: 'Sueldo cancelado correctamente.' });
  } catch (err) {
    next(err);
  }
};
