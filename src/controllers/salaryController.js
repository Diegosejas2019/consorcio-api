const Salary   = require('../models/Salary');
const Employee = require('../models/Employee');
const Expense  = require('../models/Expense');
const logger   = require('../config/logger');

const ROLE_LABELS = {
  security:    'Seguridad',
  cleaning:    'Limpieza',
  admin:       'Administración',
  maintenance: 'Mantenimiento',
  other:       'Otro',
};

function buildExpenseDescription(employee, period) {
  const roleLabel = ROLE_LABELS[employee.role] || employee.customRole || employee.role;
  return `Sueldo - ${roleLabel} - ${employee.name} - ${period}`;
}

// ── GET /api/salaries ─────────────────────────────────────────
exports.getSalaries = async (req, res, next) => {
  try {
    const { period, employeeId, status, search, page = 1, limit = 50 } = req.query;

    const filter = { organization: req.orgId };
    if (period)     filter.period   = period;
    if (employeeId) filter.employee = employeeId;
    if (status)     filter.status   = status;

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
      data: { salaries },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/salaries ────────────────────────────────────────
exports.createSalary = async (req, res, next) => {
  try {
    const { employeeId, period, baseAmount, extraAmount = 0, deductions = 0, notes, paymentMethod } = req.body;

    if (!employeeId || !period || baseAmount === undefined) {
      return res.status(400).json({ success: false, message: 'Empleado, período y monto base son obligatorios.' });
    }

    const employee = await Employee.findOne({ _id: employeeId, organization: req.orgId });
    if (!employee) return res.status(400).json({ success: false, message: 'Empleado no válido o no pertenece a esta organización.' });
    if (!employee.isActive) return res.status(400).json({ success: false, message: 'No se puede liquidar un empleado dado de baja.' });

    const totalAmount = Number(baseAmount) + Number(extraAmount) - Number(deductions);
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

    const salary = await Salary.create({
      organization: req.orgId,
      employee:     employeeId,
      period,
      baseAmount:   Number(baseAmount),
      extraAmount:  Number(extraAmount),
      deductions:   Number(deductions),
      totalAmount,
      notes,
      paymentMethod,
      expenseId:    expense._id,
      createdBy:    req.user._id,
    });

    await salary.populate('employee', 'name role customRole');

    logger.info(`Sueldo creado: ${employee.name} ${period} $${totalAmount} [org: ${req.orgId}]`);
    res.status(201).json({ success: true, data: { salary, expense } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Ya existe un sueldo para este empleado en ese período.' });
    }
    next(err);
  }
};

// ── GET /api/salaries/:id ─────────────────────────────────────
exports.getSalary = async (req, res, next) => {
  try {
    const salary = await Salary.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('employee', 'name role customRole isActive')
      .populate('expenseId')
      .select('-__v');

    if (!salary) return res.status(404).json({ success: false, message: 'Sueldo no encontrado.' });
    res.json({ success: true, data: { salary } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/salaries/:id ───────────────────────────────────
exports.updateSalary = async (req, res, next) => {
  try {
    const salary = await Salary.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('employee', 'name role customRole');

    if (!salary) return res.status(404).json({ success: false, message: 'Sueldo no encontrado.' });
    if (salary.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'No se puede modificar un sueldo cancelado.' });
    }

    const { baseAmount, extraAmount, deductions, status, paymentDate, paymentMethod, notes } = req.body;

    const newBase       = baseAmount  !== undefined ? Number(baseAmount)  : salary.baseAmount;
    const newExtra      = extraAmount !== undefined ? Number(extraAmount) : salary.extraAmount;
    const newDeductions = deductions  !== undefined ? Number(deductions)  : salary.deductions;
    const newTotal      = newBase + newExtra - newDeductions;

    if (newTotal < 0) return res.status(400).json({ success: false, message: 'El total no puede ser negativo.' });

    const newStatus = status || salary.status;

    // Actualizar salary
    salary.baseAmount   = newBase;
    salary.extraAmount  = newExtra;
    salary.deductions   = newDeductions;
    salary.totalAmount  = newTotal;
    salary.status       = newStatus;
    salary.updatedBy    = req.user._id;
    if (notes       !== undefined) salary.notes         = notes;
    if (paymentMethod !== undefined) salary.paymentMethod = paymentMethod;

    if (newStatus === 'paid' && !salary.paymentDate) {
      salary.paymentDate = paymentDate ? new Date(paymentDate) : new Date();
    }
    if (newStatus === 'cancelled') {
      salary.paymentDate = undefined;
    }

    await salary.save();

    // Sincronizar Expense asociado
    if (salary.expenseId) {
      const expenseUpdate = {
        amount:      newTotal,
        description: buildExpenseDescription(salary.employee, salary.period),
        updatedBy:   req.user._id,
      };

      if (newStatus === 'paid') {
        expenseUpdate.status = 'paid';
      } else if (newStatus === 'cancelled') {
        expenseUpdate.isActive  = false;
        expenseUpdate.deletedAt = new Date();
        expenseUpdate.deletedBy = req.user._id;
      } else {
        expenseUpdate.status = 'pending';
      }

      await Expense.findByIdAndUpdate(salary.expenseId, { $set: expenseUpdate });
    }

    logger.info(`Sueldo actualizado: ${salary._id} status=${newStatus} [org: ${req.orgId}]`);
    res.json({ success: true, data: { salary } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/salaries/:id (cancelar) ──────────────────────
exports.deleteSalary = async (req, res, next) => {
  try {
    const salary = await Salary.findOne({ _id: req.params.id, organization: req.orgId });
    if (!salary) return res.status(404).json({ success: false, message: 'Sueldo no encontrado.' });
    if (salary.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'El sueldo ya está cancelado.' });
    }

    salary.status    = 'cancelled';
    salary.updatedBy = req.user._id;
    await salary.save();

    if (salary.expenseId) {
      await Expense.findByIdAndUpdate(salary.expenseId, {
        $set: { isActive: false, deletedAt: new Date(), deletedBy: req.user._id },
      });
    }

    logger.info(`Sueldo cancelado: ${salary._id} [org: ${req.orgId}]`);
    res.json({ success: true, message: 'Sueldo cancelado correctamente.' });
  } catch (err) {
    next(err);
  }
};
