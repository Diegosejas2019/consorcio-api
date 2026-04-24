const mongoose = require('mongoose');

const unitSchema = new mongoose.Schema(
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
    },
    name: {
      type: String,
      required: [true, 'El nombre de la unidad es obligatorio'],
      trim: true,
      maxlength: [100, 'El nombre no puede superar 100 caracteres'],
    },
    coefficient: {
      type: Number,
      default: 1,
      min: [0, 'El coeficiente no puede ser negativo'],
    },
    // Si se setea, prevalece sobre (organization.monthlyFee * coefficient)
    customFee: {
      type: Number,
      default: null,
      min: [0, 'El monto personalizado no puede ser negativo'],
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Índice compuesto para queries por org + owner ─────────────
unitSchema.index({ organization: 1, owner: 1 });
unitSchema.index({ organization: 1, active: 1 });

module.exports = mongoose.model('Unit', unitSchema);
