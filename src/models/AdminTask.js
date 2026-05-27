const mongoose = require('mongoose');
const { Schema, Types: { ObjectId } } = mongoose;

const adminTaskSchema = new Schema({
  organization: { type: ObjectId, ref: 'Organization', required: true, index: true },
  title:        { type: String, required: true, trim: true, maxlength: 200 },
  notes:        { type: String, trim: true, maxlength: 1000 },
  dueDate:      { type: Date },
  status:       { type: String, enum: ['pending', 'done'], default: 'pending' },
  priority:     { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  createdBy:    { type: ObjectId, ref: 'User', required: true },
  completedBy:  { type: ObjectId, ref: 'User' },
  completedAt:  { type: Date },
}, { timestamps: true });

adminTaskSchema.index({ organization: 1, status: 1, dueDate: 1 });

module.exports = mongoose.model('AdminTask', adminTaskSchema);
