const mongoose = require('mongoose');

const salarySchema = new mongoose.Schema(
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
    period: {
      type: String,
      required: [true, 'El período es obligatorio'],
      match: [/^\d{4}-\d{2}$/, 'El período debe tener formato YYYY-MM'],
    },
    baseAmount: {
      type: Number,
      required: [true, 'El monto base es obligatorio'],
      min: [0, 'El monto base no puede ser negativo'],
    },
    extraAmount: {
      type: Number,
      default: 0,
      min: [0, 'Los extras no pueden ser negativos'],
    },
    deductions: {
      type: Number,
      default: 0,
      min: [0, 'Los descuentos no pueden ser negativos'],
    },
    totalAmount: {
      type: Number,
      required: true,
      min: [0, 'El total no puede ser negativo'],
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'cancelled'],
      default: 'pending',
    },
    paymentDate:   { type: Date },
    paymentMethod: { type: String, enum: ['cash', 'transfer'] },
    notes:         { type: String, trim: true },
    expenseId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
    createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

salarySchema.index({ organization: 1, employee: 1, period: 1 }, { unique: true });

module.exports = mongoose.model('Salary', salarySchema);
