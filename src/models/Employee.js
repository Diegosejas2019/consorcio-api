const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organización es obligatoria'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'El nombre es obligatorio'],
      trim: true,
    },
    documentNumber: { type: String, trim: true },
    phone:          { type: String, trim: true },
    email:          { type: String, trim: true, lowercase: true },
    role: {
      type: String,
      enum: ['security', 'cleaning', 'admin', 'maintenance', 'other'],
      required: [true, 'El rol es obligatorio'],
    },
    customRole:  { type: String, trim: true },
    startDate:   { type: Date },
    endDate:     { type: Date },
    isActive:    { type: Boolean, default: true },
    isOnLeave:   { type: Boolean, default: false },
    leaveNote:   { type: String, trim: true },
    schedule:    { type: String, trim: true },
    notes:       { type: String, trim: true },
    documents: [{
      url:      { type: String },
      publicId: { type: String },
      filename: { type: String },
      mimetype: { type: String },
      size:     { type: Number },
      _id:      false,
    }],
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

employeeSchema.index({ organization: 1, isActive: 1 });

module.exports = mongoose.model('Employee', employeeSchema);
