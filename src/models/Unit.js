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
      default: null,
    },
    status: {
      type: String,
      enum: ['available', 'occupied', 'inactive'],
      default: 'available',
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
    balance: {
      type: Number,
      default: 0,
    },
    isDebtor: {
      type: Boolean,
      default: false,
    },
    startBillingPeriod: {
      type: String,
      match: [/^\d{4}-\d{2}$/, 'El período de inicio debe tener formato YYYY-MM'],
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

// ── Índices ───────────────────────────────────────────────────
unitSchema.index({ organization: 1, owner: 1 });
unitSchema.index({ organization: 1, active: 1 });
unitSchema.index({ organization: 1, isDebtor: 1, active: 1 });
unitSchema.index({ organization: 1, name: 1 }, { unique: true });

unitSchema.pre('validate', function (next) {
  if (this.balance !== undefined) {
    const amount = Number(this.balance || 0);
    this.balance = amount > 0 ? -amount : amount;
    this.isDebtor = this.balance < 0;
  }
  if (this.active === false) {
    this.status = 'inactive';
  } else if (this.owner) {
    this.status = 'occupied';
  } else if (this.status === 'occupied') {
    this.status = 'available';
  }
  next();
});

module.exports = mongoose.model('Unit', unitSchema);
