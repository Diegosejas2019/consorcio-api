const mongoose = require('mongoose');

const salaryPaymentSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organizacion es obligatoria'],
      index: true,
    },
    salary: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Salary',
      required: [true, 'El sueldo es obligatorio'],
      index: true,
    },
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'El empleado es obligatorio'],
      index: true,
    },
    period: {
      type: String,
      required: [true, 'El periodo es obligatorio'],
      match: [/^\d{4}-\d{2}$/, 'El periodo debe tener formato YYYY-MM.'],
      index: true,
    },
    type: {
      type: String,
      enum: ['advance', 'salary_payment', 'adjustment'],
      required: true,
      default: 'salary_payment',
    },
    amount: {
      type: Number,
      required: [true, 'El monto es obligatorio'],
      min: [0.01, 'El monto debe ser mayor a cero.'],
    },
    paymentDate: {
      type: Date,
      default: Date.now,
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'transfer'],
      required: [true, 'El metodo de pago es obligatorio'],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'La nota no puede superar los 500 caracteres.'],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

salaryPaymentSchema.index({ organization: 1, salary: 1, isActive: 1 });
salaryPaymentSchema.index({ organization: 1, employee: 1, period: 1, isActive: 1 });

salaryPaymentSchema.virtual('typeLabel').get(function () {
  return {
    advance:        'Adelanto',
    salary_payment: 'Pago de sueldo',
    adjustment:     'Ajuste',
  }[this.type] || this.type;
});

salaryPaymentSchema.virtual('paymentMethodLabel').get(function () {
  return {
    cash:     'Efectivo',
    transfer: 'Transferencia',
  }[this.paymentMethod] || this.paymentMethod;
});

module.exports = mongoose.model('SalaryPayment', salaryPaymentSchema);
