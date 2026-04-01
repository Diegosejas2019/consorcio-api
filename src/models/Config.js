const mongoose = require('mongoose');

// Documento singleton — solo existe un registro de configuración global
const configSchema = new mongoose.Schema(
  {
    // Clave única para garantizar singleton
    _singleton: { type: String, default: 'global', unique: true },

    // ── Expensas ──────────────────────────────────────────────
    expenseAmount: {
      type: Number,
      required: true,
      min: [1, 'El importe debe ser mayor a 0'],
      default: 15000,
    },
    expenseMonth: {
      type: String,
      required: true,
      default: 'Enero 2025',
      // Ej: "Abril 2025"
    },
    expenseMonthCode: {
      type: String,
      default: '2025-01',
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato inválido (YYYY-MM)'],
    },
    lateFeePercent: {
      type: Number,
      default: 5,
      min: 0,
      max: 100,
      // Porcentaje de recargo por pago fuera de término
    },
    dueDayOfMonth: {
      type: Number,
      default: 10,
      min: 1,
      max: 28,
      // Día del mes en que vence la expensa
    },

    // ── Datos del consorcio ───────────────────────────────────
    consortiumName: {
      type: String,
      default: 'Barrio Privado',
      trim: true,
    },
    consortiumAddress: {
      type: String,
      trim: true,
    },
    adminEmail: {
      type: String,
      trim: true,
    },
    adminPhone: {
      type: String,
      trim: true,
    },

    // ── MercadoPago ───────────────────────────────────────────
    mpPublicKey: {
      type: String,
      trim: true,
      select: false, // no exponer en responses generales
    },
    mpAccessToken: {
      type: String,
      trim: true,
      select: false, // NUNCA exponer al frontend
    },
    mpWebhookSecret: {
      type: String,
      trim: true,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

// Método estático para obtener (o crear) la config global
configSchema.statics.getConfig = async function () {
  let config = await this.findOne({ _singleton: 'global' });
  if (!config) {
    config = await this.create({ _singleton: 'global' });
  }
  return config;
};

module.exports = mongoose.model('Config', configSchema);
