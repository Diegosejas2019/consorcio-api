const mongoose = require('mongoose');

const CATEGORY_LABELS = {
  regulation: 'Reglamento',
  map:        'Mapa',
  rules:      'Normas de convivencia',
  assembly:   'Asamblea',
  insurance:  'Seguro',
  payment:    'Pagos',
  contract:   'Contrato',
  other:      'Otro',
};

const VISIBILITY_LABELS = {
  admin:  'Solo administradores',
  owners: 'Visible para propietarios',
};

const organizationDocumentSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, 'El titulo es obligatorio.'],
      trim: true,
      maxlength: [120, 'El titulo no puede superar los 120 caracteres.'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'La descripcion no puede superar los 500 caracteres.'],
    },
    category: {
      type: String,
      enum: ['regulation', 'map', 'rules', 'assembly', 'insurance', 'payment', 'contract', 'other'],
      default: 'other',
    },
    visibility: {
      type: String,
      enum: ['admin', 'owners'],
      default: 'owners',
    },
    file: {
      url:      { type: String },
      publicId: { type: String },
      filename: { type: String },
      mimetype: { type: String },
      size:     { type: Number },
      _id:      false,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

organizationDocumentSchema.index({ organization: 1, isActive: 1, createdAt: -1 });
organizationDocumentSchema.index({ organization: 1, category: 1, isActive: 1 });
organizationDocumentSchema.index({ organization: 1, visibility: 1, isActive: 1 });

organizationDocumentSchema.virtual('categoryLabel').get(function categoryLabel() {
  return CATEGORY_LABELS[this.category] || this.category;
});

organizationDocumentSchema.virtual('visibilityLabel').get(function visibilityLabel() {
  return VISIBILITY_LABELS[this.visibility] || this.visibility;
});

organizationDocumentSchema.virtual('fileTypeLabel').get(function fileTypeLabel() {
  const mimetype = this.file?.mimetype;
  if (mimetype === 'application/pdf') return 'PDF';
  if (mimetype?.startsWith('image/')) return 'Imagen';
  return 'Archivo';
});

organizationDocumentSchema.virtual('formattedSize').get(function formattedSize() {
  const size = this.file?.size;
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
});

module.exports = mongoose.model('OrganizationDocument', organizationDocumentSchema);
