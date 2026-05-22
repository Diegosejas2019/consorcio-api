const mongoose = require('mongoose');

const organizationAccessRequestSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    // Snapshot del código usado al momento de la solicitud
    joinCode: {
      type: String,
      required: true,
      trim: true,
    },

    // ── Datos del solicitante ─────────────────────────────────────
    name: {
      type: String,
      required: [true, 'El nombre es obligatorio'],
      trim: true,
      maxlength: [100, 'El nombre no puede superar 100 caracteres'],
    },
    email: {
      type: String,
      required: [true, 'El email es obligatorio'],
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'El email no es válido'],
    },
    phone: {
      type: String,
      trim: true,
    },
    // Texto libre ingresado por el propietario: "Lote 15", "Depto 3A"
    requestedUnitLabel: {
      type: String,
      trim: true,
      maxlength: [100, 'La unidad no puede superar 100 caracteres'],
    },
    message: {
      type: String,
      trim: true,
      maxlength: [500, 'El mensaje no puede superar 500 caracteres'],
    },

    // ── Usuario existente ─────────────────────────────────────────
    // Presente si el solicitante ya tenía cuenta en GestionAr
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    isExistingUser: {
      type: Boolean,
      default: false,
    },

    // ── Estado ───────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },

    // ── Revisión del admin ────────────────────────────────────────
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [300, 'El motivo no puede superar 300 caracteres'],
    },

    // ID del User creado o vinculado al aprobar
    createdUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // IP del solicitante para auditoría (nunca se devuelve en queries)
    requestIp: {
      type: String,
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
organizationAccessRequestSchema.index({ organization: 1, status: 1 });
organizationAccessRequestSchema.index({ organization: 1, email: 1 });
organizationAccessRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('OrganizationAccessRequest', organizationAccessRequestSchema);
