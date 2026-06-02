const mongoose = require('mongoose');

const liquidationItemSchema = new mongoose.Schema(
  {
    code:            { type: String, required: true, trim: true },
    label:           { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['remunerative', 'non_remunerative', 'deduction', 'employer_contribution'],
      required: true,
    },
    quantity:        { type: Number, default: 1 },
    unitValue:       { type: Number, default: 0 },
    amount:          { type: Number, required: true },
    formulaSnapshot: { type: String, trim: true },
    legalReference:  { type: String, trim: true },
  },
  { _id: false }
);

const payrollLiquidationSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
    },
    period: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}$/, 'El período debe tener formato YYYY-MM'],
    },
    liquidationType: {
      type: String,
      enum: ['monthly', 'sac_first', 'sac_second', 'vacation', 'final', 'adjustment'],
      required: true,
      default: 'monthly',
    },
    status: {
      type: String,
      enum: ['draft', 'calculated', 'approved', 'paid', 'cancelled'],
      default: 'draft',
    },
    calculationProvider: {
      type: String,
      enum: ['internal', 'payroll-api-argentina'],
      default: 'internal',
    },
    calculationId: { type: String, trim: true },
    ruleVersion:   { type: String, trim: true },
    grossRemunerative:       { type: Number, default: 0 },
    grossNonRemunerative:    { type: Number, default: 0 },
    deductionsTotal:         { type: Number, default: 0 },
    employerContributionsTotal: { type: Number, default: 0 },
    netPay:                  { type: Number, default: 0 },
    itemsSnapshot: [liquidationItemSchema],
    warnings: [{ type: String }],
    receiptPdfUrl:    { type: String },
    receiptPdfPublicId: { type: String },
    expenseId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
    salaryRef:  { type: mongoose.Schema.Types.ObjectId, ref: 'Salary' },
    notes:      { type: String, trim: true },
    createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    paidAt:     { type: Date },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Índice único excluyendo canceladas
payrollLiquidationSchema.index(
  { organization: 1, employee: 1, period: 1, liquidationType: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $ne: 'cancelled' } },
  }
);

payrollLiquidationSchema.virtual('statusLabel').get(function () {
  return {
    draft:      'Borrador',
    calculated: 'Calculado',
    approved:   'Aprobado',
    paid:       'Pagado',
    cancelled:  'Cancelado',
  }[this.status] || this.status;
});

payrollLiquidationSchema.virtual('liquidationTypeLabel').get(function () {
  return {
    monthly:    'Mensual',
    sac_first:  'SAC 1er semestre',
    sac_second: 'SAC 2do semestre',
    vacation:   'Vacaciones',
    final:      'Liquidación final',
    adjustment: 'Ajuste',
  }[this.liquidationType] || this.liquidationType;
});

module.exports = mongoose.model('PayrollLiquidation', payrollLiquidationSchema);
