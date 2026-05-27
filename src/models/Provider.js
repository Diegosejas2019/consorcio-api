const mongoose = require('mongoose');

const providerSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organización es obligatoria'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'El nombre es obligatorio'],
      trim: true,
    },
    serviceType: {
      type: String,
      enum: ['cleaning', 'security', 'maintenance', 'utilities', 'administration', 'other'],
      required: [true, 'El tipo de servicio es obligatorio'],
    },
    cuit:  { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    active: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ['active', 'suspended', 'incomplete'],
      default: 'active',
    },
    contactName:    { type: String, trim: true },
    notes:          { type: String, trim: true, maxlength: 1000 },
    emergencyPhone: { type: String, trim: true },

    // ── Auditoría ─────────────────────────────────────────────
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    documents: [{
      url:            { type: String },
      publicId:       { type: String },
      filename:       { type: String },
      mimetype:       { type: String },
      size:           { type: Number },
      title:          { type: String, trim: true },
      category:       {
        type: String,
        enum: ['insurance', 'contract', 'license', 'permit', 'certificate', 'other'],
        default: 'other',
      },
      expirationDate: { type: Date },
      _id:            false,
    }],
  },
  { timestamps: true }
);

providerSchema.index({ organization: 1, active: 1 });

module.exports = mongoose.model('Provider', providerSchema);
