const { Readable } = require('stream');
const Notice = require('../models/Notice');
const logger = require('../config/logger');
const { cloudinary } = require('../config/cloudinary');
const { trackUsageEvent } = require('../services/platformUsageService');
const communicationService = require('../services/communicationService');

function withIsRead(notice, userId) {
  return communicationService.serializeNotice(notice, userId);
}
exports.withIsRead = withIsRead;

function escapedRegex(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

exports.getNotices = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, tag, category, priority, status, search } = req.query;
    const isOwner = req.accessType === 'owner';
    const filter = isOwner
      ? communicationService.buildVisibleFilterForOwner(req.orgId, req.user._id)
      : { organization: req.orgId, deletedAt: { $exists: false } };

    if (tag) filter.tag = tag;
    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (status && !isOwner) filter.status = status;
    if (search) {
      const re = escapedRegex(search);
      filter.$or = [{ title: re }, { subject: re }, { body: re }];
    }

    const numericLimit = Math.min(Number(limit) || 50, 200);
    const numericPage = Math.max(Number(page) || 1, 1);
    const [notices, total] = await Promise.all([
      Notice.find(filter)
        .populate('author', 'name')
        .populate('updatedBy', 'name')
        .sort({ sentAt: -1, createdAt: -1 })
        .skip((numericPage - 1) * numericLimit)
        .limit(numericLimit)
        .select('-__v'),
      Notice.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { notices: notices.map(n => withIsRead(n, req.user._id)) },
      pagination: {
        total,
        page: numericPage,
        limit: numericLimit,
        pages: Math.ceil(total / numericLimit),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.getNotice = async (req, res, next) => {
  try {
    const filter = req.accessType === 'owner'
      ? { _id: req.params.id, ...communicationService.buildVisibleFilterForOwner(req.orgId, req.user._id) }
      : { _id: req.params.id, organization: req.orgId, deletedAt: { $exists: false } };
    const notice = await Notice.findOne(filter).populate('author updatedBy', 'name');
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    res.json({ success: true, data: { notice: withIsRead(notice, req.user._id) } });
  } catch (err) {
    next(err);
  }
};

exports.createNotice = async (req, res, next) => {
  try {
    const notice = await communicationService.createCommunication({
      organizationId: req.orgId,
      userId: req.user._id,
      body: req.body,
      files: req.files,
    });
    await notice.populate('author', 'name');
    logger.info(`Aviso creado: "${notice.title}" por ${req.user.name}`);
    trackUsageEvent({
      organizationId: req.orgId,
      userId: req.user._id,
      role: req.user.role,
      eventType: 'notices.created',
      module: 'notices',
      metadata: {
        noticeId: notice._id.toString(),
        tag: notice.tag,
        status: notice.status,
        targetType: notice.targetType,
        attachmentsCount: notice.attachments?.length || 0,
      },
    });
    res.status(201).json({ success: true, data: { notice: withIsRead(notice, req.user._id) } });
  } catch (err) {
    next(err);
  }
};

exports.updateNotice = async (req, res, next) => {
  try {
    const notice = await communicationService.updateCommunication({
      id: req.params.id,
      organizationId: req.orgId,
      userId: req.user._id,
      body: req.body,
      files: req.files,
    });
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    await notice.populate('author updatedBy', 'name');
    res.json({ success: true, data: { notice: withIsRead(notice, req.user._id) } });
  } catch (err) {
    next(err);
  }
};

exports.deleteNotice = async (req, res, next) => {
  try {
    const notice = await Notice.findOne({ _id: req.params.id, organization: req.orgId, deletedAt: { $exists: false } });
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    notice.deletedAt = new Date();
    notice.updatedBy = req.user._id;
    await notice.save();
    res.json({ success: true, message: 'Aviso eliminado.' });
  } catch (err) {
    next(err);
  }
};

exports.getAttachment = async (req, res, next) => {
  try {
    const filter = req.accessType === 'owner'
      ? { _id: req.params.id, ...communicationService.buildVisibleFilterForOwner(req.orgId, req.user._id) }
      : { _id: req.params.id, organization: req.orgId, deletedAt: { $exists: false } };
    const notice = await Notice.findOne(filter);
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });

    const idx = parseInt(req.params.index, 10);
    const attachment = notice.attachments?.[idx];
    if (!attachment?.publicId) {
      return res.status(404).json({ success: false, message: 'Adjunto no encontrado.' });
    }

    const mimetype = attachment.mimetype || 'application/pdf';
    const isImage = mimetype.startsWith('image/');
    const resourceType = isImage ? 'image' : 'raw';
    const ext = isImage
      ? (mimetype.split('/')[1] === 'jpeg' ? 'jpg' : mimetype.split('/')[1])
      : 'pdf';
    const deliveryType = attachment.url?.includes('/authenticated/') ? 'authenticated' : 'upload';

    const signedUrl = cloudinary.utils.private_download_url(
      attachment.publicId,
      ext,
      { resource_type: resourceType, type: deliveryType, expires_at: Math.floor(Date.now() / 1000) + 120 }
    );

    const cloudRes = await fetch(signedUrl);
    if (!cloudRes.ok) {
      logger.error(`Cloudinary proxy error: ${cloudRes.status} - publicId: ${attachment.publicId}`);
      return res.status(502).json({ success: false, message: 'No se pudo obtener el adjunto desde Cloudinary.' });
    }

    const filename = (attachment.filename || `adjunto.${ext}`).replace(/"/g, '');
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${filename}"`);
    const contentLength = cloudRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    Readable.fromWeb(cloudRes.body).pipe(res);
  } catch (err) {
    next(err);
  }
};

exports.markAsRead = async (req, res, next) => {
  try {
    const notice = await Notice.findOne({
      _id: req.params.id,
      ...communicationService.buildVisibleFilterForOwner(req.orgId, req.user._id),
    });
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    await communicationService.markCommunicationAsRead({
      id: req.params.id,
      organizationId: req.orgId,
      userId: req.user._id,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

exports.markAsUnread = async (req, res, next) => {
  try {
    const notice = await Notice.findOne({
      _id: req.params.id,
      ...communicationService.buildVisibleFilterForOwner(req.orgId, req.user._id),
    });
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    await communicationService.markCommunicationAsRead({
      id: req.params.id,
      organizationId: req.orgId,
      userId: req.user._id,
      unread: true,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

exports.sendNow = async (req, res, next) => {
  try {
    const notice = await communicationService.sendCommunicationNow({
      id: req.params.id,
      organizationId: req.orgId,
      userId: req.user._id,
    });
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    await notice.populate('author updatedBy', 'name');
    res.json({ success: true, data: { notice: withIsRead(notice, req.user._id) } });
  } catch (err) {
    next(err);
  }
};

exports.cancel = async (req, res, next) => {
  try {
    const notice = await communicationService.cancelCommunication({
      id: req.params.id,
      organizationId: req.orgId,
      userId: req.user._id,
    });
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    res.json({ success: true, data: { notice: withIsRead(notice, req.user._id) } });
  } catch (err) {
    next(err);
  }
};

exports.processScheduled = async (req, res, next) => {
  try {
    const result = await communicationService.processScheduledCommunications({
      organizationId: req.orgId,
      userId: req.user._id,
    });
    res.json({
      success: true,
      data: { processed: result.processed.length, failed: result.failed },
    });
  } catch (err) {
    next(err);
  }
};

exports.getStats = async (req, res, next) => {
  try {
    const stats = await communicationService.getCommunicationStats({
      id: req.params.id,
      organizationId: req.orgId,
    });
    if (!stats) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    res.json({ success: true, data: { stats } });
  } catch (err) {
    next(err);
  }
};
