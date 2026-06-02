const EmployeePayrollProfile = require('../models/EmployeePayrollProfile');
const Employee = require('../models/Employee');
const logger = require('../config/logger');

// GET /api/payroll/employee-profiles
exports.getProfiles = async (req, res, next) => {
  try {
    const { employeeId, active } = req.query;
    const filter = { organization: req.orgId };
    if (employeeId) filter.employee = employeeId;
    if (active !== undefined) filter.active = active === 'true';

    // cuil y cbu tienen select:false — no aparecen en listado
    const profiles = await EmployeePayrollProfile.find(filter)
      .populate('employee', 'name role customRole isActive')
      .sort({ createdAt: -1 })
      .select('-__v -cuil -cbu');

    res.json({ success: true, data: { profiles } });
  } catch (err) {
    next(err);
  }
};

// GET /api/payroll/employee-profiles/:id
exports.getProfile = async (req, res, next) => {
  try {
    const profile = await EmployeePayrollProfile.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('employee', 'name role customRole isActive')
      .select('+cuil +cbu -__v');

    if (!profile) return res.status(404).json({ success: false, message: 'Perfil laboral no encontrado.' });
    res.json({ success: true, data: { profile } });
  } catch (err) {
    next(err);
  }
};

// POST /api/payroll/employee-profiles
exports.createProfile = async (req, res, next) => {
  try {
    const { employeeId, cuil, cbu, category, convention, hireDate, seniorityDate, employmentType, workSchedule, baseSalary } = req.body;

    if (!employeeId || !cuil || !hireDate || baseSalary === undefined) {
      return res.status(400).json({ success: false, message: 'Empleado, CUIL, fecha de ingreso y sueldo básico son obligatorios.' });
    }

    const employee = await Employee.findOne({ _id: employeeId, organization: req.orgId });
    if (!employee) return res.status(400).json({ success: false, message: 'Empleado no válido o no pertenece a esta organización.' });

    const existing = await EmployeePayrollProfile.findOne({ organization: req.orgId, employee: employeeId });
    if (existing) return res.status(409).json({ success: false, message: 'Ya existe un perfil laboral para este empleado.' });

    const profile = await EmployeePayrollProfile.create({
      organization: req.orgId,
      employee: employeeId,
      cuil,
      cbu,
      category,
      convention,
      hireDate,
      seniorityDate,
      employmentType,
      workSchedule,
      baseSalary: Number(baseSalary),
      baseSalaryHistory: [{ amount: Number(baseSalary), effectiveFrom: hireDate || new Date(), setBy: req.user._id }],
      createdBy: req.user._id,
    });

    logger.info(`EmployeePayrollProfile creado: ${employee.name} [org: ${req.orgId}]`);
    const safe = await EmployeePayrollProfile.findById(profile._id).populate('employee', 'name role').select('-__v -cuil -cbu');
    res.status(201).json({ success: true, data: { profile: safe } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Ya existe un perfil laboral para este empleado.' });
    }
    next(err);
  }
};

// PATCH /api/payroll/employee-profiles/:id
exports.updateProfile = async (req, res, next) => {
  try {
    const profile = await EmployeePayrollProfile.findOne({ _id: req.params.id, organization: req.orgId });
    if (!profile) return res.status(404).json({ success: false, message: 'Perfil laboral no encontrado.' });

    const allowed = ['cuil', 'cbu', 'category', 'convention', 'hireDate', 'seniorityDate', 'employmentType', 'workSchedule'];
    allowed.forEach(f => { if (req.body[f] !== undefined) profile[f] = req.body[f]; });

    // Actualización de sueldo básico con historial
    if (req.body.baseSalary !== undefined && Number(req.body.baseSalary) !== profile.baseSalary) {
      profile.baseSalary = Number(req.body.baseSalary);
      profile.baseSalaryHistory.push({ amount: profile.baseSalary, effectiveFrom: new Date(), setBy: req.user._id });
    }

    profile.updatedBy = req.user._id;
    await profile.save();

    const safe = await EmployeePayrollProfile.findById(profile._id).populate('employee', 'name role').select('-__v -cuil -cbu');
    res.json({ success: true, data: { profile: safe } });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/payroll/employee-profiles/:id/deactivate
exports.deactivateProfile = async (req, res, next) => {
  try {
    const profile = await EmployeePayrollProfile.findOne({ _id: req.params.id, organization: req.orgId });
    if (!profile) return res.status(404).json({ success: false, message: 'Perfil laboral no encontrado.' });

    profile.active = false;
    profile.updatedBy = req.user._id;
    await profile.save();

    res.json({ success: true, message: 'Perfil laboral desactivado.' });
  } catch (err) {
    next(err);
  }
};
