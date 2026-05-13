const mongoose = require('mongoose');

const paymentPlanInstallmentSchema = new mongoose.Schema(
  {
    organization: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Organization',
      required: true,
      index:    true,
    },
    paymentPlan: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'PaymentPlan',
      required: true,
      index:    true,
    },
    owner: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },

    installmentNumber: { type: Number, required: true, min: 1 },
    dueDate:           { type: Date, required: true },
    amount:            { type: Number, required: true, min: 0.01 },
    currency:          { type: String, enum: ['ARS', 'USD'], default: 'ARS' },

    status: {
      type:    String,
      enum:    ['pending', 'paid', 'overdue', 'cancelled'],
      default: 'pending',
      index:   true,
    },

    paidAt:    { type: Date },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    receiptId: { type: String },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

paymentPlanInstallmentSchema.index({ paymentPlan: 1, installmentNumber: 1 });
paymentPlanInstallmentSchema.index({ organization: 1, owner: 1, status: 1 });
paymentPlanInstallmentSchema.index({ dueDate: 1, status: 1 });

module.exports = mongoose.model('PaymentPlanInstallment', paymentPlanInstallmentSchema);
