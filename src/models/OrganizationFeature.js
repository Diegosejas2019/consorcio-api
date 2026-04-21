const mongoose = require('mongoose');

const organizationFeatureSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    featureKey: {
      type: String,
      required: true,
      trim: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Clave única por organización + featureKey
organizationFeatureSchema.index({ organization: 1, featureKey: 1 }, { unique: true });

module.exports = mongoose.model('OrganizationFeature', organizationFeatureSchema);
