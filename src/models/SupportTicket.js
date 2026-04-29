const mongoose = require('mongoose');

const SUPPORT_TICKET_TYPES = ['bug', 'question', 'payment_issue', 'suggestion', 'other'];
const SUPPORT_TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const SUPPORT_TICKET_PRIORITIES = ['low', 'medium', 'high'];

const supportTicketSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userRole: { type: String, enum: ['admin', 'owner'], required: true },
    type: { type: String, enum: SUPPORT_TICKET_TYPES, required: [true, 'El tipo de ticket es obligatorio'] },
    title: {
      type: String,
      required: [true, 'El titulo es obligatorio'],
      trim: true,
      minlength: [3, 'El titulo debe tener al menos 3 caracteres'],
      maxlength: [150, 'El titulo no puede superar 150 caracteres'],
    },
    description: {
      type: String,
      required: [true, 'La descripcion es obligatoria'],
      trim: true,
      minlength: [10, 'La descripcion debe tener al menos 10 caracteres'],
      maxlength: [3000, 'La descripcion no puede superar 3000 caracteres'],
    },
    status: { type: String, enum: SUPPORT_TICKET_STATUSES, default: 'open', index: true },
    priority: { type: String, enum: SUPPORT_TICKET_PRIORITIES, default: 'medium', index: true },
    context: {
      route: { type: String, trim: true, maxlength: 500 },
      userAgent: { type: String, trim: true, maxlength: 500 },
      action: { type: String, trim: true, maxlength: 150 },
      metadata: { type: mongoose.Schema.Types.Mixed, default: undefined },
    },
    adminResponse: {
      type: String,
      trim: true,
      maxlength: [3000, 'La respuesta no puede superar 3000 caracteres'],
    },
    resolvedAt: Date,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

supportTicketSchema.index({ organizationId: 1, createdAt: -1 });
supportTicketSchema.index({ organizationId: 1, status: 1, type: 1, priority: 1 });
supportTicketSchema.index({ organizationId: 1, userId: 1, createdAt: -1 });

supportTicketSchema.virtual('typeLabel').get(function () {
  return {
    bug: 'Error en la app',
    question: 'Consulta',
    payment_issue: 'Problema con pago',
    suggestion: 'Sugerencia',
    other: 'Otro',
  }[this.type] || this.type;
});

supportTicketSchema.virtual('statusLabel').get(function () {
  return {
    open: 'Abierto',
    in_progress: 'En proceso',
    resolved: 'Resuelto',
    closed: 'Cerrado',
  }[this.status] || this.status;
});

supportTicketSchema.virtual('priorityLabel').get(function () {
  return {
    low: 'Baja',
    medium: 'Media',
    high: 'Alta',
  }[this.priority] || this.priority;
});

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
module.exports.SUPPORT_TICKET_TYPES = SUPPORT_TICKET_TYPES;
module.exports.SUPPORT_TICKET_STATUSES = SUPPORT_TICKET_STATUSES;
module.exports.SUPPORT_TICKET_PRIORITIES = SUPPORT_TICKET_PRIORITIES;
