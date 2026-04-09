const mongoose = require('mongoose');

/**
 * Labels por tipo de negocio — usados como defaults al crear la org.
 * El admin puede sobreescribirlos en cualquier momento.
 */
const LABELS_BY_TYPE = {
  consorcio: { feeLabel: 'Expensa',     memberLabel: 'Propietario', unitLabel: 'Lote / Casa'   },
  gimnasio:  { feeLabel: 'Cuota',       memberLabel: 'Socio',       unitLabel: 'Membresía'     },
  colegio:   { feeLabel: 'Arancel',     memberLabel: 'Alumno',      unitLabel: 'Legajo'        },
  club:      { feeLabel: 'Cuota',       memberLabel: 'Socio',       unitLabel: 'Nº de Socio'   },
  other:     { feeLabel: 'Cuota',       memberLabel: 'Cliente',     unitLabel: 'Identificador' },
};

const organizationSchema = new mongoose.Schema(
  {
    // ── Identidad ────────────────────────────────────────────────
    name: {
      type: String,
      required: [true, 'El nombre de la organización es obligatorio'],
      trim: true,
      maxlength: [150, 'El nombre no puede superar 150 caracteres'],
    },
    slug: {
      type: String,
      required: [true, 'El slug es obligatorio'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-]+$/, 'El slug solo puede contener letras minúsculas, números y guiones'],
    },
    businessType: {
      type: String,
      enum: ['consorcio', 'gimnasio', 'colegio', 'club', 'other'],
      default: 'consorcio',
    },
    isActive: {
      type: Boolean,
      default: true,
    },

    // ── Configuración de cobros ───────────────────────────────────
    feeAmount: {
      type: Number,
      default: 0,
      min: [0, 'El importe no puede ser negativo'],
    },
    // Período actual de cobro: "2025-04"
    feePeriodCode: {
      type: String,
      default: '',
      match: [/^$|^\d{4}-(0[1-9]|1[0-2])$/, 'Formato inválido (YYYY-MM)'],
    },
    // Versión legible del período: "Abril 2025"
    feePeriodLabel: {
      type: String,
      default: '',
      trim: true,
    },
    lateFeePercent: {
      type: Number,
      default: 5,
      min: 0,
      max: 100,
    },
    dueDayOfMonth: {
      type: Number,
      default: 10,
      min: 1,
      max: 28,
    },

    // ── Terminología (personalizable por tipo de negocio) ─────────
    // Nombre de la cuota/expensa/arancel
    feeLabel: {
      type: String,
      default: 'Cuota',
      trim: true,
      maxlength: 50,
    },
    // Nombre del miembro (Propietario / Socio / Alumno / Cliente)
    memberLabel: {
      type: String,
      default: 'Cliente',
      trim: true,
      maxlength: 50,
    },
    // Nombre de la unidad (Lote / Membresía / Legajo / ID)
    unitLabel: {
      type: String,
      default: 'Unidad',
      trim: true,
      maxlength: 50,
    },

    // ── Datos de contacto ─────────────────────────────────────────
    address: {
      type: String,
      trim: true,
    },
    adminEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    adminPhone: {
      type: String,
      trim: true,
    },

    // ── MercadoPago (nunca se exponen en respuestas generales) ────
    mpPublicKey: {
      type: String,
      trim: true,
      select: false,
    },
    mpAccessToken: {
      type: String,
      trim: true,
      select: false,
    },
    mpWebhookSecret: {
      type: String,
      trim: true,
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON:  { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Índices ──────────────────────────────────────────────────────
organizationSchema.index({ slug: 1 }, { unique: true });
organizationSchema.index({ businessType: 1, isActive: 1 });

// ── Static: labels por defecto para un tipo de negocio ──────────
organizationSchema.statics.defaultLabels = function (businessType) {
  return { ...(LABELS_BY_TYPE[businessType] || LABELS_BY_TYPE.other) };
};

// ── Static: crear slug a partir del nombre ───────────────────────
organizationSchema.statics.generateSlug = function (name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
};

module.exports = mongoose.model('Organization', organizationSchema);
