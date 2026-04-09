const mongoose = require('mongoose');

const receiptSchema = new mongoose.Schema(
  {
    url:       { type: String },            // URL en Cloudinary
    publicId:  { type: String },            // ID en Cloudinary para borrar
    filename:  { type: String },            // Nombre original del archivo
    mimetype:  { type: String },            // image/jpeg, application/pdf, etc.
    size:      { type: Number },            // bytes
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
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

    // ── Período ───────────────────────────────────────────────
    month: {
      type: String,
      required: [true, 'El período es obligatorio'],
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato de mes inválido (YYYY-MM)'],
      // Ej: "2025-04"
    },

    // ── Importe ───────────────────────────────────────────────
    amount: {
      type: Number,
      required: [true, 'El importe es obligatorio'],
      min: [1, 'El importe debe ser mayor a 0'],
    },

    // ── Estado ───────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },

    // ── Comprobante (archivo) ─────────────────────────────────
    receipt: receiptSchema,

    // ── Canal de pago ─────────────────────────────────────────
    paymentMethod: {
      type: String,
      enum: ['manual', 'mercadopago'],
      default: 'manual',
    },

    // ── MercadoPago ───────────────────────────────────────────
    mpPreferenceId:  { type: String },
    mpPaymentId:     { type: String },
    mpStatus:        { type: String },   // approved, pending, rejected, etc.
    mpDetail:        { type: String },   // detail code de MP

    // ── Revisión del administrador ────────────────────────────
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: Date,
    rejectionNote: {
      type: String,
      maxlength: [500, 'La nota no puede superar 500 caracteres'],
    },

    // ── Nota del propietario ──────────────────────────────────
    ownerNote: {
      type: String,
      maxlength: [300, 'La nota no puede superar 300 caracteres'],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Índices compuestos ───────────────────────────────────────
paymentSchema.index({ organization: 1, owner: 1, month: 1 });
paymentSchema.index({ organization: 1, status: 1, createdAt: -1 });
paymentSchema.index({ organization: 1, month: 1, status: 1 });

// ── Virtual: mes formateado ──────────────────────────────────
paymentSchema.virtual('monthFormatted').get(function () {
  const months = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  const [year, month] = this.month.split('-');
  return `${months[parseInt(month) - 1]} ${year}`;
});

// ── Evitar duplicados: un solo pago activo por propietario/mes ─
paymentSchema.index(
  { owner: 1, month: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['pending', 'approved'] } },
  }
);

module.exports = mongoose.model('Payment', paymentSchema);
