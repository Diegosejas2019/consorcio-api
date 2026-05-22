const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema({
  url:       { type: String },
  publicId:  { type: String },
  filename:  { type: String },
  mimetype:  { type: String },
  size:      { type: Number },
  uploadedBy:{ type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  uploadedAt:{ type: Date, default: Date.now },
}, { _id: true });

const unidentifiedPaymentSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: [true, 'La organización es obligatoria'],
    index: true,
  },

  amount: {
    type: Number,
    required: [true, 'El importe es obligatorio'],
    min: [1, 'El importe debe ser mayor a 0'],
    index: true,
  },

  paymentDate: {
    type: Date,
    required: [true, 'La fecha de pago es obligatoria'],
    index: true,
  },

  receivedAt: {
    type: Date,
    default: Date.now,
  },

  paymentMethod: {
    type: String,
    enum: ['transferencia', 'deposito', 'efectivo', 'mercadopago', 'otro'],
    required: [true, 'El método de pago es obligatorio'],
    index: true,
  },

  reference: {
    type: String,
    trim: true,
    index: true,
  },

  senderName: {
    type: String,
    trim: true,
  },

  senderAccount: {
    type: String,
    trim: true,
  },

  description: {
    type: String,
    trim: true,
  },

  status: {
    type: String,
    enum: ['pending', 'partially_matched', 'associated', 'rejected', 'archived'],
    default: 'pending',
    index: true,
  },

  attachments: [attachmentSchema],

  matchedOwnerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },

  matchedUnitId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Unit',
  },

  matchedPeriods: [{
    type: String,
    match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato de período inválido (YYYY-MM)'],
  }],

  associatedPaymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
  },

  associatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },

  associatedAt: {
    type: Date,
  },

  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },

  rejectedAt: {
    type: Date,
  },

  rejectionReason: {
    type: String,
    trim: true,
  },

  archivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },

  archivedAt: {
    type: Date,
  },

  archiveReason: {
    type: String,
    trim: true,
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },

  isDeleted: {
    type: Boolean,
    default: false,
    index: true,
  },

  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },

  deletedAt: {
    type: Date,
  },
}, { timestamps: true });

unidentifiedPaymentSchema.index({ organization: 1, status: 1 });
unidentifiedPaymentSchema.index({ organization: 1, paymentDate: -1 });
unidentifiedPaymentSchema.index({ organization: 1, amount: 1 });
unidentifiedPaymentSchema.index({ organization: 1, reference: 1 });
unidentifiedPaymentSchema.index({ organization: 1, paymentMethod: 1 });
unidentifiedPaymentSchema.index({ createdBy: 1 });
unidentifiedPaymentSchema.index({ matchedOwnerId: 1 });
unidentifiedPaymentSchema.index({ associatedPaymentId: 1 });
unidentifiedPaymentSchema.index({ isDeleted: 1, organization: 1, status: 1 });

unidentifiedPaymentSchema.virtual('paymentMethodLabel').get(function() {
  const labels = {
    transferencia: 'Transferencia',
    deposito: 'Depósito',
    efectivo: 'Efectivo',
    mercadopago: 'MercadoPago',
    otro: 'Otro',
  };
  return labels[this.paymentMethod] || this.paymentMethod;
});

unidentifiedPaymentSchema.virtual('statusLabel').get(function() {
  const labels = {
    pending: 'Pendiente',
    partially_matched: 'Parcialmente coincidente',
    associated: 'Asociado',
    rejected: 'Rechazado',
    archived: 'Archivado',
  };
  return labels[this.status] || this.status;
});

unidentifiedPaymentSchema.set('toJSON', { virtuals: true });
unidentifiedPaymentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('UnidentifiedPayment', unidentifiedPaymentSchema);