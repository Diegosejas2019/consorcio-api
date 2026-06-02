const mongoose = require('mongoose');

const baseSalaryHistorySchema = new mongoose.Schema(
  {
    amount:       { type: Number, required: true, min: 0 },
    effectiveFrom: { type: Date, required: true },
    setBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

const employeePayrollProfileSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organización es obligatoria'],
      index: true,
    },
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'El empleado es obligatorio'],
    },
    cuil: {
      type: String,
      trim: true,
      required: [true, 'El CUIL es obligatorio'],
      match: [/^\d{11}$/, 'El CUIL debe tener 11 dígitos sin guiones'],
      select: false,
    },
    cbu: {
      type: String,
      trim: true,
      match: [/^\d{22}$/, 'El CBU debe tener 22 dígitos'],
      select: false,
    },
    category:      { type: String, trim: true },
    convention:    { type: String, trim: true },
    hireDate: {
      type: Date,
      required: [true, 'La fecha de ingreso es obligatoria'],
    },
    seniorityDate: { type: Date },
    employmentType: {
      type: String,
      enum: ['permanent', 'temporary', 'trainee'],
      default: 'permanent',
    },
    workSchedule: {
      type: String,
      enum: ['full_time', 'part_time', 'other'],
      default: 'full_time',
    },
    baseSalary: {
      type: Number,
      required: [true, 'El sueldo básico es obligatorio'],
      min: [0, 'El sueldo básico no puede ser negativo'],
    },
    baseSalaryHistory: [baseSalaryHistorySchema],
    active:    { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

employeePayrollProfileSchema.index({ organization: 1, employee: 1 }, { unique: true });

module.exports = mongoose.model('EmployeePayrollProfile', employeePayrollProfileSchema);
