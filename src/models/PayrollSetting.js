const mongoose = require('mongoose');

const payrollSettingSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organización es obligatoria'],
      unique: true,
      index: true,
    },
    employerLegalName: {
      type: String,
      trim: true,
      required: [true, 'La razón social del empleador es obligatoria'],
    },
    employerCuit: {
      type: String,
      trim: true,
      required: [true, 'El CUIT del empleador es obligatorio'],
      match: [/^\d{11}$/, 'El CUIT debe tener 11 dígitos sin guiones'],
    },
    employerAddress:  { type: String, trim: true },
    employerActivity: { type: String, trim: true },
    defaultConvention: { type: String, trim: true },
    defaultPaymentMethod: {
      type: String,
      enum: ['cash', 'transfer'],
      default: 'transfer',
    },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PayrollSetting', payrollSettingSchema);
