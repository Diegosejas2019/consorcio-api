const mongoose = require('mongoose');

/**
 * Templates de configuración por tipo de negocio.
 * Incluyen terminología, reglas de cobro y metadatos para el frontend.
 * El admin puede sobreescribir cualquier campo después de la creación.
 */
const TEMPLATES = {
  consorcio: {
    businessType:    'consorcio',
    displayName:     'Consorcio / Barrio Privado',
    description:     'Gestión de expensas, propietarios y unidades funcionales.',
    feeLabel:        'Expensa',
    memberLabel:     'Propietario',
    unitLabel:       'Lote / Casa',
    lateFeePercent:  0,
    dueDayOfMonth:   10,
    feeAmount:       0,
  },
  gimnasio: {
    businessType:    'gimnasio',
    displayName:     'Gimnasio / Centro Deportivo',
    description:     'Cuotas mensuales de socios y membresías.',
    feeLabel:        'Cuota mensual',
    memberLabel:     'Socio',
    unitLabel:       'Membresía',
    lateFeePercent:  0,
    dueDayOfMonth:   1,
    feeAmount:       0,
  },
  colegio: {
    businessType:    'colegio',
    displayName:     'Colegio / Instituto',
    description:     'Aranceles de alumnos y gestión de legajos.',
    feeLabel:        'Arancel',
    memberLabel:     'Alumno',
    unitLabel:       'Legajo',
    lateFeePercent:  0,
    dueDayOfMonth:   5,
    feeAmount:       0,
  },
  club: {
    businessType:    'club',
    displayName:     'Club Social / Deportivo',
    description:     'Cuotas sociales y gestión de socios.',
    feeLabel:        'Cuota social',
    memberLabel:     'Socio',
    unitLabel:       'Nº de Socio',
    lateFeePercent:  0,
    dueDayOfMonth:   1,
    feeAmount:       0,
  },
  other: {
    businessType:    'other',
    displayName:     'Otra organización',
    description:     'Configuración genérica completamente personalizable.',
    feeLabel:        'Cuota',
    memberLabel:     'Cliente',
    unitLabel:       'Identificador',
    lateFeePercent:  0,
    dueDayOfMonth:   10,
    feeAmount:       0,
  },
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
    // Monto mensual por defecto (se usa como importe base en pagos)
    monthlyFee: {
      type: Number,
      default: 0,
      min: [0, 'El monto mensual no puede ser negativo'],
    },
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
    // Períodos habilitados para pago: ["2025-04", "2025-05"]
    paymentPeriods: {
      type: [String],
      default: [],
      validate: {
        validator: arr => arr.every(v => /^\d{4}-(0[1-9]|1[0-2])$/.test(v)),
        message: 'Formato inválido en períodos de pago (YYYY-MM)',
      },
    },
    lateFeeType: {
      type: String,
      enum: ['percent', 'fixed'],
      default: 'percent',
    },
    lateFeePercent: {
      type: Number,
      default: 5,
      min: 0,
      max: 100,
    },
    lateFeeFixed: {
      type: Number,
      default: 0,
      min: 0,
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
    cuit: {
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

    // ── Datos bancarios para transferencia ───────────────────────
    bankName: {
      type: String,
      trim: true,
      default: '',
    },
    bankAccount: {
      type: String,
      trim: true,
      default: '',
    },
    bankCbu: {
      type: String,
      trim: true,
      default: '',
    },
    bankHolder: {
      type: String,
      trim: true,
      default: '',
    },

    // ── Contador secuencial de recibos ───────────────────────────
    receiptCounter: {
      type:    Number,
      default: 0,
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
// slug ya tiene unique:true en el campo, no se necesita schema.index adicional
organizationSchema.index({ businessType: 1, isActive: 1 });

// ── Static: labels por defecto para un tipo de negocio ──────────
organizationSchema.statics.defaultLabels = function (businessType) {
  const t = TEMPLATES[businessType] || TEMPLATES.other;
  return { feeLabel: t.feeLabel, memberLabel: t.memberLabel, unitLabel: t.unitLabel };
};

// ── Static: preset completo de un template ───────────────────────
organizationSchema.statics.getTemplate = function (businessType) {
  return { ...(TEMPLATES[businessType] || TEMPLATES.other) };
};

// ── Static: lista todos los templates disponibles ────────────────
organizationSchema.statics.listTemplates = function () {
  return Object.values(TEMPLATES).map(({ businessType, displayName, description, feeLabel, memberLabel, unitLabel, lateFeePercent, dueDayOfMonth }) => ({
    businessType,
    displayName,
    description,
    defaults: { feeLabel, memberLabel, unitLabel, lateFeePercent, dueDayOfMonth },
  }));
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
