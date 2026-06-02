const mongoose = require('mongoose');

const payrollRuleVersionSchema = new mongoose.Schema(
  {
    version: {
      type: String,
      required: [true, 'La versión es obligatoria'],
      unique: true,
      trim: true,
    },
    country: {
      type: String,
      default: 'AR',
      enum: ['AR'],
    },
    effectiveFrom: {
      type: Date,
      required: [true, 'La fecha de inicio de vigencia es obligatoria'],
    },
    effectiveTo: { type: Date },
    rules: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      required: [true, 'Las reglas son obligatorias'],
    },
    source: { type: String, trim: true },
    notes:  { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

payrollRuleVersionSchema.index({ country: 1, effectiveFrom: -1 });

module.exports = mongoose.model('PayrollRuleVersion', payrollRuleVersionSchema);
