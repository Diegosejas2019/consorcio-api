const mongoose = require('mongoose');

const noticeReadReceiptSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    notice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notice',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    unit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Unit',
    },
    readAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

noticeReadReceiptSchema.index({ organization: 1, notice: 1, user: 1 }, { unique: true });
noticeReadReceiptSchema.index({ organization: 1, user: 1, readAt: -1 });

module.exports = mongoose.model('NoticeReadReceipt', noticeReadReceiptSchema);
