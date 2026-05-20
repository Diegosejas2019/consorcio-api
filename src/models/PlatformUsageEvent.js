const mongoose = require('mongoose');

const platformUsageEventSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'super_admin', 'superadmin'],
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    module: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

platformUsageEventSchema.index({ createdAt: -1 });
platformUsageEventSchema.index({ organizationId: 1, createdAt: -1 });
platformUsageEventSchema.index({ eventType: 1, createdAt: -1 });

module.exports = mongoose.model('PlatformUsageEvent', platformUsageEventSchema);
