const mongoose = require('mongoose');

const includedPeriodSchema = new mongoose.Schema(
  {
    month:          { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    originalAmount: { type: Number, default: 0 },
  },
  { _id: false }
);

const paymentPlanSchema = new mongoose.Schema(
  {
    organization: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Organization',
      required: true,
      index:    true,
    },
    owner: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },
    requestedBy: {
      type: String,
      enum: ['owner', 'admin'],
      required: true,
    },
    status: {
      type:    String,
      enum:    ['requested', 'approved', 'active', 'completed', 'rejected', 'cancelled', 'defaulted'],
      default: 'requested',
      index:   true,
    },
    currency: {
      type:    String,
      enum:    ['ARS', 'USD'],
      default: 'ARS',
    },

    originalDebtAmount: { type: Number, required: true, min: 0 },
    interestType:       { type: String, enum: ['none', 'percentage', 'fixed'], default: 'none' },
    interestValue:      { type: Number, default: 0, min: 0 },
    interestAmount:     { type: Number, default: 0, min: 0 },
    totalAmount:        { type: Number, default: 0, min: 0 },

    installmentsCount: { type: Number, min: 1 },
    startDate:         { type: Date },
    frequency:         { type: String, enum: ['monthly'], default: 'monthly' },

    includedPeriods: { type: [includedPeriodSchema], default: [] },

    requestComment: { type: String, maxlength: 500 },
    adminComment:   { type: String, maxlength: 500 },
    rejectionReason: { type: String, maxlength: 500 },

    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    approvedAt:  { type: Date },
    rejectedAt:  { type: Date },
    cancelledAt: { type: Date },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

paymentPlanSchema.index({ organization: 1, owner: 1, status: 1 });
paymentPlanSchema.index({ organization: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentPlan', paymentPlanSchema);
