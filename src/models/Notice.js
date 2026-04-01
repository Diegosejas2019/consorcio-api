const mongoose = require('mongoose');

const noticeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'El título es obligatorio'],
      trim: true,
      maxlength: [150, 'El título no puede superar 150 caracteres'],
    },
    body: {
      type: String,
      required: [true, 'El contenido es obligatorio'],
      trim: true,
      maxlength: [2000, 'El contenido no puede superar 2000 caracteres'],
    },
    tag: {
      type: String,
      enum: ['info', 'warning', 'urgent'],
      default: 'info',
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Push notification enviada a propietarios
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

noticeSchema.index({ createdAt: -1 });
noticeSchema.index({ tag: 1 });

// Virtual: etiqueta legible
noticeSchema.virtual('tagLabel').get(function () {
  const labels = { info: 'Informativo', warning: 'Advertencia', urgent: 'Urgente' };
  return labels[this.tag] || this.tag;
});

module.exports = mongoose.model('Notice', noticeSchema);
