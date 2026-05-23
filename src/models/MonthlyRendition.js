const mongoose = require('mongoose');

const warningSchema = new mongoose.Schema({
  code:     { type: String, required: true },
  message:  { type: String, required: true },
  severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
}, { _id: false });

const monthlyRenditionSchema = new mongoose.Schema({
  organization: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Organization',
    required: true,
    index:    true,
  },
  period: {
    type:     String,
    required: true,
    match:    /^\d{4}-\d{2}$/,
    index:    true,
  },
  generatedAt: { type: Date, default: Date.now },
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  observations: {
    type:    String,
    default: '',
    maxlength: [4000, 'Las observaciones no pueden superar los 4000 caracteres'],
  },
  warnings:  { type: [warningSchema], default: [] },
  pdfUrl:    { type: String },
  pdfPublicId: { type: String },
  status: {
    type:    String,
    enum:    ['draft', 'generated', 'archived'],
    default: 'draft',
  },
  version: { type: Number, default: 1 },
}, { timestamps: true });

monthlyRenditionSchema.index({ organization: 1, period: 1, version: 1 }, { unique: true });
monthlyRenditionSchema.index({ organization: 1, period: 1 });

module.exports = mongoose.model('MonthlyRendition', monthlyRenditionSchema);
