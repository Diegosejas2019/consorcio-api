const mongoose = require('mongoose');

const CATEGORIES = ['general', 'mantenimiento', 'corte_servicio', 'expensas', 'asamblea', 'mora', 'seguridad', 'emergencia', 'otro'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['draft', 'scheduled', 'sent', 'cancelled'];
const TARGET_TYPES = ['all', 'owners', 'tenants', 'specific_units', 'specific_users', 'debtors'];

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
      maxlength: [5000, 'El contenido no puede superar 5000 caracteres'],
    },
    tag: {
      type: String,
      enum: ['info', 'warning', 'urgent'],
      default: 'info',
    },
    subject: {
      type: String,
      trim: true,
      maxlength: [180, 'El asunto no puede superar 180 caracteres'],
    },
    category: {
      type: String,
      enum: CATEGORIES,
      default: 'general',
      index: true,
    },
    priority: {
      type: String,
      enum: PRIORITIES,
      default: 'normal',
      index: true,
    },
    status: {
      type: String,
      enum: STATUSES,
      default: 'sent',
      index: true,
    },
    scheduledAt: Date,
    sentAt: Date,
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    targetType: {
      type: String,
      enum: TARGET_TYPES,
      default: 'all',
      index: true,
    },
    targetFilters: {
      unitIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Unit' }],
      userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      includeInactive: { type: Boolean, default: false },
      onlyWithDebt: { type: Boolean, default: false },
      periodId: { type: String, trim: true },
    },
    channels: {
      app: { type: Boolean, default: true },
      email: { type: Boolean, default: false },
      push: { type: Boolean, default: false },
      whatsapp: { type: Boolean, default: false },
    },
    readTrackingEnabled: {
      type: Boolean,
      default: true,
    },
    recipientSnapshot: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
        name: String,
        email: String,
        unitName: String,
        _id: false,
      },
    ],
    // Push notification enviada a propietarios
    pushSent: {
      type: Boolean,
      default: false,
    },
    pushSentAt: Date,
    // Email enviado a propietarios
    emailSent: {
      type: Boolean,
      default: false,
    },
    emailSentAt: Date,
    // Propietarios que han leído el aviso
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    attachments: [
      {
        url:      String,
        publicId: String,
        filename: String,
        mimetype: String,
        size:     Number,
      },
    ],
    deletedAt: Date,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

noticeSchema.index({ createdAt: -1 });
noticeSchema.index({ tag: 1 });
noticeSchema.index({ organization: 1, status: 1, createdAt: -1 });
noticeSchema.index({ organization: 1, deletedAt: 1 });
noticeSchema.index({ organization: 1, scheduledAt: 1, status: 1 });

// Virtual: etiqueta legible
noticeSchema.virtual('tagLabel').get(function () {
  const labels = { info: 'Informativo', warning: 'Advertencia', urgent: 'Urgente' };
  return labels[this.tag] || this.tag;
});

noticeSchema.virtual('categoryLabel').get(function () {
  const labels = {
    general: 'General',
    mantenimiento: 'Mantenimiento',
    corte_servicio: 'Corte de servicio',
    expensas: 'Expensas',
    asamblea: 'Asamblea',
    mora: 'Mora',
    seguridad: 'Seguridad',
    emergencia: 'Emergencia',
    otro: 'Otro',
  };
  return labels[this.category || 'general'] || this.category;
});

noticeSchema.virtual('priorityLabel').get(function () {
  const labels = { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
  return labels[this.priority || 'normal'] || this.priority;
});

noticeSchema.virtual('statusLabel').get(function () {
  const labels = { draft: 'Borrador', scheduled: 'Programado', sent: 'Enviado', cancelled: 'Cancelado' };
  return labels[this.status || 'sent'] || this.status;
});

noticeSchema.pre('validate', function (next) {
  if (!this.subject) this.subject = this.title;
  if (!this.channels) this.channels = {};
  this.channels.app = true;
  if (!this.priority) {
    this.priority = this.tag === 'urgent' ? 'urgent' : this.tag === 'warning' ? 'high' : 'normal';
  }
  if (!this.tag) {
    this.tag = this.priority === 'urgent' ? 'urgent' : this.priority === 'high' ? 'warning' : 'info';
  }
  if (!this.sentAt && this.status === 'sent') this.sentAt = new Date();
  next();
});

noticeSchema.statics.categories = CATEGORIES;
noticeSchema.statics.priorities = PRIORITIES;
noticeSchema.statics.statuses = STATUSES;
noticeSchema.statics.targetTypes = TARGET_TYPES;

module.exports = mongoose.model('Notice', noticeSchema);
