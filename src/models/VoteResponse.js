const mongoose = require('mongoose');

const voteResponseSchema = new mongoose.Schema(
  {
    vote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vote',
      required: true,
      index: true,
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Índice de la opción elegida dentro del array Vote.options
    optionIndex: {
      type: Number,
      required: [true, 'Debés seleccionar una opción.'],
      min: [0, 'Opción inválida.'],
    },
  },
  { timestamps: true }
);

// Un propietario vota una sola vez por votación
voteResponseSchema.index({ vote: 1, owner: 1 }, { unique: true });

module.exports = mongoose.model('VoteResponse', voteResponseSchema);
