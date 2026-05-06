const Salary = require('../models/Salary');
const SalaryPayment = require('../models/SalaryPayment');
const {
  getActiveSalaryPaidAmount,
  recalculateSalaryPaymentStatus,
  round2,
} = require('../services/salaryPaymentService');

const VALID_TYPES = ['advance', 'salary_payment', 'adjustment'];
const VALID_PAYMENT_METHODS = ['cash', 'transfer'];

exports.getSalaryPayments = async (req, res, next) => {
  try {
    const { salary, employee, period, type } = req.query;

    const filter = { organization: req.orgId, isActive: { $ne: false } };
    if (salary) filter.salary = salary;
    if (employee) filter.employee = employee;
    if (period) filter.period = period;
    if (type) filter.type = type;

    const salaryPayments = await SalaryPayment.find(filter)
      .populate('employee', 'name role customRole')
      .populate('salary', 'period totalAmount paidAmount remainingAmount status')
      .sort({ paymentDate: -1, createdAt: -1 })
      .select('-__v');

    res.json({ success: true, data: { salaryPayments } });
  } catch (err) {
    next(err);
  }
};

exports.createSalaryPayment = async (req, res, next) => {
  try {
    const { salary: salaryId, amount, type = 'salary_payment', paymentDate, paymentMethod, note, employee } = req.body;

    if (!salaryId) {
      return res.status(400).json({ success: false, message: 'El sueldo es obligatorio.' });
    }
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: 'El tipo de movimiento no es valido.' });
    }
    if (!(Number(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'El monto debe ser mayor a cero.' });
    }
    if (!paymentMethod) {
      return res.status(400).json({ success: false, message: 'El metodo de pago es obligatorio.' });
    }
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: 'El metodo de pago no es valido.' });
    }

    const salary = await Salary.findOne({ _id: salaryId, organization: req.orgId });
    if (!salary) {
      return res.status(404).json({ success: false, message: 'Sueldo no encontrado.' });
    }
    if (employee && employee.toString() !== salary.employee.toString()) {
      return res.status(400).json({ success: false, message: 'El empleado no coincide con el sueldo indicado.' });
    }
    if (salary.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'No se pueden registrar pagos sobre un sueldo cancelado.' });
    }
    if (salary.status === 'paid') {
      return res.status(400).json({ success: false, message: 'El sueldo ya esta pagado.' });
    }

    const paidAmount = await getActiveSalaryPaidAmount(salary._id);
    const remainingAmount = Math.max(round2(salary.totalAmount) - paidAmount, 0);
    if (round2(Number(amount)) > round2(remainingAmount)) {
      return res.status(400).json({ success: false, message: 'El monto ingresado supera el saldo pendiente del sueldo.' });
    }

    const salaryPayment = await SalaryPayment.create({
      organization: req.orgId,
      salary:       salary._id,
      employee:     salary.employee,
      period:       salary.period,
      type,
      amount:       round2(Number(amount)),
      paymentDate:  paymentDate ? new Date(paymentDate) : new Date(),
      paymentMethod,
      note,
      createdBy:    req.user._id,
    });

    const updatedSalary = await recalculateSalaryPaymentStatus(salary._id, req.user._id);

    res.status(201).json({ success: true, data: { salaryPayment, salary: updatedSalary } });
  } catch (err) {
    next(err);
  }
};

exports.deleteSalaryPayment = async (req, res, next) => {
  try {
    const salaryPayment = await SalaryPayment.findOne({
      _id:          req.params.id,
      organization: req.orgId,
      isActive:     { $ne: false },
    });

    if (!salaryPayment) {
      return res.status(404).json({ success: false, message: 'Movimiento de sueldo no encontrado.' });
    }

    salaryPayment.isActive = false;
    salaryPayment.updatedBy = req.user._id;
    await salaryPayment.save();

    const salary = await recalculateSalaryPaymentStatus(salaryPayment.salary, req.user._id);

    res.json({ success: true, data: { salaryPayment, salary } });
  } catch (err) {
    next(err);
  }
};
