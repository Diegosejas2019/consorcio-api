const Employee = require('../models/Employee');
const Salary   = require('../models/Salary');
const logger   = require('../config/logger');

const ROLE_LABELS = {
  security:    'Seguridad',
  cleaning:    'Limpieza',
  admin:       'Administración',
  maintenance: 'Mantenimiento',
  other:       'Otro',
};

// ── GET /api/employees ────────────────────────────────────────
exports.getEmployees = async (req, res, next) => {
  try {
    const { search, role, isActive } = req.query;

    const filter = { organization: req.orgId };
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ name: re }, { documentNumber: re }];
    }

    const employees = await Employee.find(filter).sort({ name: 1 }).select('-__v');

    res.json({ success: true, data: { employees } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/employees ───────────────────────────────────────
exports.createEmployee = async (req, res, next) => {
  try {
    const allowed = ['name', 'documentNumber', 'phone', 'email', 'role', 'customRole', 'startDate', 'endDate', 'notes'];
    const data = { organization: req.orgId, createdBy: req.user._id };
    allowed.forEach(f => { if (req.body[f] !== undefined) data[f] = req.body[f]; });

    const employee = await Employee.create(data);
    logger.info(`Empleado creado: ${employee.name} [org: ${req.orgId}]`);
    res.status(201).json({ success: true, data: { employee } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/employees/:id ────────────────────────────────────
exports.getEmployee = async (req, res, next) => {
  try {
    const employee = await Employee.findOne({ _id: req.params.id, organization: req.orgId }).select('-__v');
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });
    res.json({ success: true, data: { employee } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/employees/:id ──────────────────────────────────
exports.updateEmployee = async (req, res, next) => {
  try {
    const allowed = ['name', 'documentNumber', 'phone', 'email', 'role', 'customRole', 'startDate', 'endDate', 'notes', 'isActive'];
    const setFields = { updatedBy: req.user._id };
    allowed.forEach(f => { if (req.body[f] !== undefined) setFields[f] = req.body[f]; });

    const employee = await Employee.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      { $set: setFields },
      { new: true, runValidators: true }
    ).select('-__v');

    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });

    res.json({ success: true, data: { employee } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/employees/:id (soft delete) ───────────────────
exports.deleteEmployee = async (req, res, next) => {
  try {
    const employee = await Employee.findOne({ _id: req.params.id, organization: req.orgId });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });
    if (!employee.isActive) return res.status(400).json({ success: false, message: 'El empleado ya está dado de baja.' });

    const pendingSalary = await Salary.findOne({ employee: employee._id, organization: req.orgId, status: 'pending' });
    if (pendingSalary) {
      return res.status(400).json({ success: false, message: 'No se puede dar de baja un empleado con sueldos pendientes de pago.' });
    }

    employee.isActive  = false;
    employee.endDate   = employee.endDate || new Date();
    employee.updatedBy = req.user._id;
    await employee.save();

    logger.info(`Empleado dado de baja: ${employee.name} [org: ${req.orgId}]`);
    res.json({ success: true, message: 'Empleado dado de baja correctamente.' });
  } catch (err) {
    next(err);
  }
};

exports.ROLE_LABELS = ROLE_LABELS;
