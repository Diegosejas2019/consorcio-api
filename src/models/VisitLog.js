const mongoose = require('mongoose');

const visitLogSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    visit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Visit',
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: ['check_in', 'check_out'],
      required: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    performedByName: String,
    performedByRole: String,
    comment: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    visitorName: String,
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    ownerName: String,
    unitLabel: String,
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

visitLogSchema.index({ organization: 1, timestamp: -1 });

module.exports = mongoose.model('VisitLog', visitLogSchema);
