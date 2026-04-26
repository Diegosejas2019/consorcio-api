const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organización es obligatoria'],
      index: true,
    },
    description: {
      type: String,
      required: [true, 'La descripción es obligatoria'],
      trim: true,
    },
    category: {
      type: String,
      enum: ['cleaning', 'security', 'maintenance', 'utilities', 'administration', 'other'],
      required: [true, 'La categoría es obligatoria'],
    },
    amount: {
      type: Number,
      required: [true, 'El importe es obligatorio'],
      min: [0.01, 'El importe debe ser mayor a 0'],
    },
    date: {
      type: Date,
      required: [true, 'La fecha es obligatoria'],
    },
    provider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Provider',
    },
    status: {
      type: String,
      enum: ['pending', 'paid'],
      default: 'pending',
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'transfer', 'mercadopago'],
    },
    attachments: [{
      url:      { type: String },
      publicId: { type: String },
      filename: { type: String },
      mimetype: { type: String },
      size:     { type: Number },
      _id:      false,
    }],
    expenseType: {
      type: String,
      enum: ['ordinary', 'extraordinary'],
      default: 'ordinary',
    },
    invoiceNumber: {
      type: String,
      trim: true,
    },
    invoiceCuit: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // ── Auditoría / soft delete ───────────────────────────────
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date },
    isActive:  { type: Boolean, default: true },
  },
  { timestamps: true }
);

expenseSchema.index({ organization: 1, date: -1 });
expenseSchema.index({ organization: 1, status: 1 });
expenseSchema.index({ organization: 1, isActive: 1 });

module.exports = mongoose.model('Expense', expenseSchema);
