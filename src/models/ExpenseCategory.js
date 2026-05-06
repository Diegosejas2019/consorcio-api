const mongoose = require('mongoose');

const expenseCategorySchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'La organizacion es obligatoria'],
      index: true,
    },
    key: {
      type: String,
      required: [true, 'La clave es obligatoria'],
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9_-]+$/, 'La clave solo puede contener letras, numeros, guiones y guiones bajos'],
      maxlength: [50, 'La clave no puede superar 50 caracteres'],
    },
    label: {
      type: String,
      required: [true, 'El nombre es obligatorio'],
      trim: true,
      maxlength: [80, 'El nombre no puede superar 80 caracteres'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

expenseCategorySchema.index({ organization: 1, key: 1 }, { unique: true });
expenseCategorySchema.index({ organization: 1, isActive: 1 });

module.exports = mongoose.model('ExpenseCategory', expenseCategorySchema);
