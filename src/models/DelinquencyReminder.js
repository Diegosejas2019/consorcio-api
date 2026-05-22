const mongoose = require('mongoose');

const delinquencyReminderSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organización es obligatoria'],
      index: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'El propietario es obligatorio'],
      index: true,
    },
    unit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Unit',
    },
    debtAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    periods: [{
      type: String,
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'El período debe tener formato YYYY-MM.'],
    }],
    channel: {
      type: String,
      enum: ['app', 'email', 'whatsapp', 'manual'],
      default: 'app',
    },
    message: {
      type: String,
      required: [true, 'El mensaje es obligatorio'],
      trim: true,
      maxlength: [5000, 'El mensaje no puede superar 5000 caracteres'],
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['sent', 'logged', 'failed'],
      default: 'sent',
      index: true,
    },
    notice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notice',
    },
  },
  { timestamps: true }
);

delinquencyReminderSchema.index({ organization: 1, owner: 1, sentAt: -1 });

module.exports = mongoose.model('DelinquencyReminder', delinquencyReminderSchema);
