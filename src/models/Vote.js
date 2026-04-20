const mongoose = require('mongoose');

const optionSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: [true, 'El texto de la opción es obligatorio'],
      trim: true,
      maxlength: [200, 'La opción no puede superar 200 caracteres'],
    },
    votes: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

const voteSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, 'El título es obligatorio'],
      trim: true,
      maxlength: [150, 'El título no puede superar 150 caracteres'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'La descripción no puede superar 2000 caracteres'],
    },
    options: {
      type: [optionSchema],
      validate: {
        validator: (arr) => arr.length >= 2,
        message: 'La votación debe tener al menos 2 opciones.',
      },
    },
    status: {
      type: String,
      enum: ['open', 'closed'],
      default: 'open',
    },
    endsAt: {
      type: Date,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    closedAt: {
      type: Date,
    },
    pushSent: {
      type: Boolean,
      default: false,
    },
    pushSentAt: Date,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

voteSchema.index({ organization: 1, status: 1, createdAt: -1 });

voteSchema.virtual('totalVotes').get(function () {
  return this.options.reduce((sum, o) => sum + o.votes, 0);
});

voteSchema.virtual('statusLabel').get(function () {
  return this.status === 'open' ? 'Abierta' : 'Cerrada';
});

module.exports = mongoose.model('Vote', voteSchema);
