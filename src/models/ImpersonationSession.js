const mongoose = require('mongoose');

const impersonationSessionSchema = new mongoose.Schema(
  {
    actorUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    actorEmail: { type: String, required: true, trim: true },
    impersonatedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    impersonatedEmail: { type: String, required: true, trim: true },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    role:      { type: String, required: true },
    adminRole: { type: String, default: null },
    reason:    { type: String, required: true, trim: true, maxlength: 1000 },
    sessionId: { type: String, required: true, unique: true, index: true },
    startedAt: { type: Date, default: Date.now, index: true },
    endedAt:   { type: Date, default: null },
    ip:        { type: String, select: false },
    userAgent: { type: String, select: false },
    status: {
      type: String,
      enum: ['active', 'ended', 'expired'],
      default: 'active',
    },
  },
  { timestamps: false }
);

module.exports = mongoose.model('ImpersonationSession', impersonationSessionSchema);
