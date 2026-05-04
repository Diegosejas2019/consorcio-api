const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

const userSchema = new mongoose.Schema(
  {
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
      match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    password: {
      type: String,
      required: [true, 'La contraseña es obligatoria'],
      minlength: [6, 'La contraseña debe tener al menos 6 caracteres'],
      select: false, // nunca se devuelve en queries por defecto
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'super_admin', 'superadmin'],
      default: 'owner',
    },

    // — Organización a la que pertenece el usuario —
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
    },

    // — Datos del propietario —
    unitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Unit',
      default: null,
    },
    // @deprecated — compatibilidad con datos legacy; el modelo relacional es Unit.
    unit: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    // @deprecated — leer desde OrganizationMember; se mantiene solo para docs legacy
    balance: {
      type: Number,
      default: 0,
    },
    // @deprecated — leer desde OrganizationMember
    percentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // @deprecated — leer desde OrganizationMember
    isDebtor: {
      type: Boolean,
      default: false,
    },

    // — Firebase Push Token —
    fcmToken: {
      type: String,
      select: false,
    },

    // @deprecated — leer desde OrganizationMember
    startBillingPeriod: {
      type: String,
      match: [/^\d{4}-\d{2}$/, 'El período de inicio debe tener formato YYYY-MM'],
    },

    // — Auditoría —
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // — Control de acceso —
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLogin: Date,
    passwordChangedAt: Date,

    // — Reset de contraseña —
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Índices ──────────────────────────────────────────────────
userSchema.index({ email: 1, organization: 1 }, { unique: true });
userSchema.index({ organization: 1, role: 1, isActive: 1 });
userSchema.index({ organization: 1, isDebtor: 1 });

// ── Virtual: unidades del propietario ────────────────────────
userSchema.virtual('units', {
  ref: 'Unit',
  localField: '_id',
  foreignField: 'owner',
});

// ── Virtual: initials ────────────────────────────────────────
userSchema.virtual('initials').get(function () {
  if (!this.name) return '';
  return this.name
    .split(' ')
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
});

// ── Pre-save: hashear password ───────────────────────────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.passwordChangedAt = Date.now() - 1000;
  next();
});

// ── Método: comparar password ────────────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// ── Método: verificar si password cambió post JWT ────────────
userSchema.methods.changedPasswordAfter = function (jwtIssuedAt) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(this.passwordChangedAt.getTime() / 1000, 10);
    return jwtIssuedAt < changedTimestamp;
  }
  return false;
};

// ── Método: generar token de reset (devuelve el token en texto plano) ──
userSchema.methods.createPasswordResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString('hex');

  // Solo se guarda el hash en la DB — el token en texto plano viaja por email
  this.passwordResetToken   = crypto.createHash('sha256').update(resetToken).digest('hex');
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutos

  return resetToken;
};

module.exports = mongoose.model('User', userSchema);
