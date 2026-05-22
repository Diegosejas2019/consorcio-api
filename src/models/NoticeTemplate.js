const mongoose = require('mongoose');

const CATEGORIES = ['general', 'mantenimiento', 'corte_servicio', 'expensas', 'asamblea', 'mora', 'seguridad', 'emergencia', 'otro'];

const noticeTemplateSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organizacion es obligatoria.'],
      index: true,
    },
    title: {
      type: String,
      required: [true, 'El titulo es obligatorio.'],
      trim: true,
      maxlength: [150, 'El titulo no puede superar 150 caracteres.'],
    },
    subject: {
      type: String,
      required: [true, 'El asunto es obligatorio.'],
      trim: true,
      maxlength: [180, 'El asunto no puede superar 180 caracteres.'],
    },
    body: {
      type: String,
      required: [true, 'El contenido es obligatorio.'],
      trim: true,
      maxlength: [5000, 'El contenido no puede superar 5000 caracteres.'],
    },
    category: {
      type: String,
      enum: CATEGORIES,
      default: 'general',
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    deletedAt: Date,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

noticeTemplateSchema.index({ organization: 1, isActive: 1, createdAt: -1 });
noticeTemplateSchema.index({ organization: 1, category: 1, isActive: 1 });

noticeTemplateSchema.pre('validate', function (next) {
  if (!this.subject && this.title) this.subject = this.title;
  next();
});

noticeTemplateSchema.statics.categories = CATEGORIES;

module.exports = mongoose.model('NoticeTemplate', noticeTemplateSchema);
