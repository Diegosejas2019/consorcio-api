const mongoose = require('mongoose');

const unidentifiedPaymentEventSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },

  unidentifiedPayment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UnidentifiedPayment',
    required: true,
    index: true,
  },

  eventType: {
    type: String,
    enum: [
      'created',
      'updated',
      'attachment_added',
      'attachment_removed',
      'suggestion_viewed',
      'associated',
      'rejected',
      'archived',
      'restored',
      'note_added',
    ],
    required: true,
    index: true,
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: false });

unidentifiedPaymentEventSchema.index({ unidentifiedPayment: 1, createdAt: -1 });
unidentifiedPaymentEventSchema.index({ organization: 1, eventType: 1 });
unidentifiedPaymentEventSchema.index({ userId: 1 });

unidentifiedPaymentEventSchema.virtual('eventTypeLabel').get(function() {
  const labels = {
    created: 'Creado',
    updated: 'Editado',
    attachment_added: 'Adjunto agregado',
    attachment_removed: 'Adjunto eliminado',
    suggestion_viewed: 'Sugerencias vistas',
    associated: 'Asociado a deuda',
    rejected: 'Rechazado',
    archived: 'Archivado',
    restored: 'Restaurado',
    note_added: 'Nota agregada',
  };
  return labels[this.eventType] || this.eventType;
});

unidentifiedPaymentEventSchema.set('toJSON', { virtuals: true });
unidentifiedPaymentEventSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('UnidentifiedPaymentEvent', unidentifiedPaymentEventSchema);