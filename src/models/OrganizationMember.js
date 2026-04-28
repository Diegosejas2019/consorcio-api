const mongoose = require('mongoose');

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const organizationMemberSchema = new Schema(
  {
    user: {
      type: ObjectId,
      ref: 'User',
      required: [true, 'El usuario es obligatorio'],
    },
    organization: {
      type: ObjectId,
      ref: 'Organization',
      required: [true, 'La organización es obligatoria'],
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'superadmin'],
      required: [true, 'El rol es obligatorio'],
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
    percentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// ── Índices ──────────────────────────────────────────────────
organizationMemberSchema.index({ user: 1, organization: 1, role: 1 }, { unique: true });
organizationMemberSchema.index({ organization: 1, role: 1, isActive: 1 });
organizationMemberSchema.index({ user: 1, isActive: 1 });

module.exports = mongoose.model('OrganizationMember', organizationMemberSchema);
