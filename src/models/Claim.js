const mongoose = require('mongoose');

const claimSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    category: {
      type: String,
      enum: ['infrastructure', 'security', 'noise', 'cleaning', 'billing', 'other'],
      required: [true, 'La categoría es obligatoria'],
    },
    title: {
      type: String,
      required: [true, 'El título es obligatorio'],
      trim: true,
      maxlength: [150, 'El título no puede superar 150 caracteres'],
    },
    body: {
      type: String,
      required: [true, 'La descripción es obligatoria'],
      trim: true,
      maxlength: [2000, 'La descripción no puede superar 2000 caracteres'],
    },
    status: {
      type: String,
      enum: ['open', 'in_progress', 'resolved'],
      default: 'open',
    },
    adminNote: {
      type: String,
      trim: true,
      maxlength: [1000, 'La nota no puede superar 1000 caracteres'],
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    resolvedAt: Date,

    // ── Auditoría / soft delete ───────────────────────────────
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date },
    isActive:  { type: Boolean, default: true },

    attachments: [
      {
        url:      String,
        publicId: String,
        filename: String,
        mimetype: String,
        size:     Number,
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

claimSchema.index({ owner: 1, createdAt: -1 });
claimSchema.index({ status: 1 });
claimSchema.index({ organization: 1, isActive: 1 });

claimSchema.virtual('categoryLabel').get(function () {
  const labels = {
    infrastructure: 'Infraestructura',
    security:       'Seguridad',
    noise:          'Ruidos',
    cleaning:       'Limpieza',
    billing:        'Facturación',
    other:          'Otro',
  };
  return labels[this.category] || this.category;
});

claimSchema.virtual('statusLabel').get(function () {
  const labels = { open: 'Abierto', in_progress: 'En proceso', resolved: 'Resuelto' };
  return labels[this.status] || this.status;
});

module.exports = mongoose.model('Claim', claimSchema);
