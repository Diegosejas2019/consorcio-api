const mongoose = require('mongoose');

const reservationSchema = new mongoose.Schema(
  {
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
    space: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Space',
      required: [true, 'El espacio es obligatorio'],
    },
    date: {
      type: String,
      required: [true, 'La fecha es obligatoria'],
      match: [/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato YYYY-MM-DD'],
    },
    startTime: {
      type: String,
      required: [true, 'La hora de inicio es obligatoria'],
      match: [/^\d{2}:\d{2}$/, 'La hora de inicio debe tener el formato HH:mm'],
    },
    endTime: {
      type: String,
      required: [true, 'La hora de fin es obligatoria'],
      match: [/^\d{2}:\d{2}$/, 'La hora de fin debe tener el formato HH:mm'],
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, 'La nota no puede superar 500 caracteres'],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Índice compuesto para consultas de disponibilidad
reservationSchema.index({ organization: 1, space: 1, date: 1 });
reservationSchema.index({ owner: 1, createdAt: -1 });

reservationSchema.virtual('statusLabel').get(function () {
  const labels = {
    pending:   'Pendiente',
    approved:  'Aprobada',
    rejected:  'Rechazada',
    cancelled: 'Cancelada',
  };
  return labels[this.status] || this.status;
});

module.exports = mongoose.model('Reservation', reservationSchema);
