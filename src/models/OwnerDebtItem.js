const mongoose = require('mongoose');

const ownerDebtItemSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organización es obligatoria'],
      index: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'El propietario es obligatorio'],
      index: true,
    },
    type: {
      type: String,
      enum: {
        values: ['previous_balance', 'manual_adjustment'],
        message: 'El tipo debe ser "previous_balance" o "manual_adjustment".',
      },
      required: [true, 'El tipo es obligatorio'],
    },
    description: {
      type: String,
      required: [true, 'La descripción es obligatoria'],
      trim: true,
    },
    amount: {
      type: Number,
      required: [true, 'El importe es obligatorio'],
      min: [0.01, 'El importe debe ser mayor a cero'],
    },
    currency: {
      type: String,
      enum: {
        values: ['ARS', 'USD'],
        message: 'La moneda debe ser ARS o USD.',
      },
      required: [true, 'La moneda es obligatoria'],
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'includedInPaymentPlan', 'cancelled'],
      default: 'pending',
    },
    originDate: { type: Date },
    dueDate:    { type: Date },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    cancelledBy:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancellationReason:  { type: String, trim: true },
    cancelledAt:         { type: Date },
    paidAt:              { type: Date },
    paymentId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    receiptId:           { type: String },
    isActive:            { type: Boolean, default: true },
    deletedAt:           { type: Date },
  },
  { timestamps: true }
);

ownerDebtItemSchema.index({ organization: 1, owner: 1 });
ownerDebtItemSchema.index({ organization: 1, status: 1 });

module.exports = mongoose.model('OwnerDebtItem', ownerDebtItemSchema);
