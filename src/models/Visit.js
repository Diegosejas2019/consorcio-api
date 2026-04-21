const mongoose = require('mongoose');

const visitSchema = new mongoose.Schema(
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
    name: {
      type: String,
      required: [true, 'El nombre del visitante es obligatorio'],
      trim: true,
      maxlength: [150, 'El nombre no puede superar 150 caracteres'],
    },
    type: {
      type: String,
      enum: ['visit', 'provider', 'delivery'],
      required: [true, 'El tipo de visita es obligatorio'],
    },
    expectedDate: {
      type: Date,
      required: [true, 'La fecha esperada es obligatoria'],
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'inside', 'exited'],
      default: 'pending',
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'La nota no puede superar 500 caracteres'],
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedAt: Date,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

visitSchema.index({ owner: 1, createdAt: -1 });
visitSchema.index({ status: 1 });
visitSchema.index({ expectedDate: 1 });

visitSchema.virtual('typeLabel').get(function () {
  const labels = { visit: 'Visita', provider: 'Proveedor', delivery: 'Delivery' };
  return labels[this.type] || this.type;
});

visitSchema.virtual('statusLabel').get(function () {
  const labels = {
    pending:  'Pendiente',
    approved: 'Aprobada',
    rejected: 'Rechazada',
    inside:   'Adentro',
    exited:   'Salió',
  };
  return labels[this.status] || this.status;
});

module.exports = mongoose.model('Visit', visitSchema);
