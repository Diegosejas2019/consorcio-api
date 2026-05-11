const { Readable }    = require('stream');
const Notice          = require('../models/Notice');
const User            = require('../models/User');
const firebaseService = require('../services/firebaseService');
const emailService    = require('../services/emailService');
const logger          = require('../config/logger');
const { cloudinary, deleteCloudinaryAttachments } = require('../config/cloudinary');

// Agrega isRead para el usuario actual y elimina readBy del resultado
function withIsRead(notice, userId) {
  const obj = notice.toObject ? notice.toObject() : notice;
  obj.isRead = (obj.readBy || []).some(id => id.toString() === userId.toString());
  delete obj.readBy;
  return obj;
}
exports.withIsRead = withIsRead;

// ── GET /api/notices ──────────────────────────────────────────
exports.getNotices = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, tag } = req.query;
    const filter = { organization: req.orgId };
    if (tag) filter.tag = tag;

    const [notices, total] = await Promise.all([
      Notice.find(filter)
        .populate('author', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-__v'),
      Notice.countDocuments(filter),
    ]);

    const userId = req.user._id;
    const mapped = notices.map(n => withIsRead(n, userId));

    res.json({
      success: true,
      data: { notices: mapped },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/notices/:id ──────────────────────────────────────
exports.getNotice = async (req, res, next) => {
  try {
    const notice = await Notice.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('author', 'name');
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    res.json({ success: true, data: { notice: withIsRead(notice, req.user._id) } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/notices — crear aviso (admin) ───────────────────
exports.createNotice = async (req, res, next) => {
  try {
    const parseBool = (v, def) => v === undefined ? def : (v === 'false' || v === false ? false : Boolean(v));
    const { title, body, tag } = req.body;
    const sendPush     = parseBool(req.body.sendPush, true);
    const doSendEmail  = parseBool(req.body.sendEmail, true);

    const noticeData = { organization: req.orgId, title, body, tag, author: req.user._id };

    if (req.files?.length) {
      noticeData.attachments = req.files.map(f => ({
        url:      f.path,
        publicId: f.filename,
        filename: f.originalname,
        mimetype: f.mimetype,
        size:     f.size,
      }));
    }

    const notice = await Notice.create(noticeData);

    // Enviar push notification solo a los propietarios de esta organización
    if (sendPush) {
      logger.info(`[Push] Iniciando envío para aviso ${notice._id} (tag: ${tag})`);
      const owners = await User.find({ organization: req.orgId, role: 'owner', isActive: true })
        .select('+fcmToken');
      const withToken    = owners.filter(o => o.fcmToken);
      const withoutToken = owners.filter(o => !o.fcmToken);
      const tokens       = withToken.map(o => o.fcmToken);

      logger.info(`[Push] Owners activos: ${owners.length} — con token: ${withToken.length}, sin token: ${withoutToken.length}`);
      if (withoutToken.length > 0) {
        logger.debug(`[Push] Owners sin FCM token: ${withoutToken.map(o => o.email).join(', ')}`);
      }

      if (tokens.length === 0) {
        logger.warn(`[Push] Ningún owner tiene FCM token registrado. No se envía push.`);
      } else {
        const tagEmoji = { info: '📢', warning: '⚠️', urgent: '🚨' };
        try {
          logger.info(`[Push] Llamando sendMulticast con ${tokens.length} token(s)...`);
          const results = await firebaseService.sendMulticast(tokens, {
            title: `${tagEmoji[tag] ?? '📢'} ${title}`,
            body:  body.slice(0, 100) + (body.length > 100 ? '...' : ''),
            data:  { type: 'new_notice', noticeId: notice._id.toString(), tag },
          });
          const totalSuccess = results?.reduce((acc, r) => acc + r.successCount, 0) ?? 0;
          const totalFailure = results?.reduce((acc, r) => acc + r.failureCount, 0) ?? 0;
          logger.info(`[Push] Resultado: ${totalSuccess} exitosos, ${totalFailure} fallidos`);
          if (totalSuccess > 0) {
            const now = new Date();
            await Notice.findByIdAndUpdate(notice._id, { pushSent: true, pushSentAt: now });
            notice.pushSent = true;
            notice.pushSentAt = now;
          } else {
            logger.warn(`[Push] Ningún push llegó a destino para aviso ${notice._id}`);
          }
        } catch (pushErr) {
          logger.error(`[Push] Error enviando push para aviso ${notice._id}: ${pushErr.message}`, { stack: pushErr.stack });
        }
      }
    }

    // Enviar emails a todos los propietarios (fire and forget)
    if (doSendEmail) {
      User.find({ organization: req.orgId, role: 'owner', isActive: true })
        .then(async (emailOwners) => {
          if (!emailOwners.length) return;
          const results = await Promise.allSettled(
            emailOwners.map(o => emailService.sendNoticeEmail(o, notice))
          );
          const ok   = results.filter(r => r.status === 'fulfilled').length;
          const fail = results.filter(r => r.status === 'rejected').length;
          logger.info(`[Email] Aviso "${notice.title}": ${ok} emails enviados, ${fail} fallidos`);
          if (ok > 0) {
            await Notice.findByIdAndUpdate(notice._id, { emailSent: true, emailSentAt: new Date() });
          }
        })
        .catch(e => logger.error(`[Email] Error obteniendo owners para aviso ${notice._id}: ${e.message}`));
    }

    await notice.populate('author', 'name');
    logger.info(`Aviso creado: "${notice.title}" por ${req.user.name}`);
    res.status(201).json({ success: true, data: { notice: withIsRead(notice, req.user._id) } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/notices/:id — editar aviso (admin) ─────────────
exports.updateNotice = async (req, res, next) => {
  try {
    const { title, body, tag } = req.body;
    const update = { $set: {} };
    if (title !== undefined) update.$set.title = title;
    if (body  !== undefined) update.$set.body  = body;
    if (tag   !== undefined) update.$set.tag   = tag;

    if (req.files?.length) {
      const newAttachments = req.files.map(f => ({
        url:      f.path,
        publicId: f.filename,
        filename: f.originalname,
        mimetype: f.mimetype,
        size:     f.size,
      }));
      update.$push = { attachments: { $each: newAttachments } };
    }

    const notice = await Notice.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      update,
      { new: true, runValidators: true }
    ).populate('author', 'name');

    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    res.json({ success: true, data: { notice: withIsRead(notice, req.user._id) } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/notices/:id — eliminar aviso (admin) ──────────
exports.deleteNotice = async (req, res, next) => {
  try {
    const notice = await Notice.findOneAndDelete({ _id: req.params.id, organization: req.orgId });
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });
    if (notice.attachments?.length) {
      await deleteCloudinaryAttachments(notice.attachments);
    }
    res.json({ success: true, message: 'Aviso eliminado.' });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/notices/:id/attachment/:index ────────────────────
exports.getAttachment = async (req, res, next) => {
  try {
    const notice = await Notice.findOne({ _id: req.params.id, organization: req.orgId });
    if (!notice) return res.status(404).json({ success: false, message: 'Aviso no encontrado.' });

    const idx        = parseInt(req.params.index, 10);
    const attachment = notice.attachments?.[idx];
    if (!attachment?.publicId) {
      return res.status(404).json({ success: false, message: 'Adjunto no encontrado.' });
    }

    const mimetype     = attachment.mimetype || 'application/pdf';
    const isImage      = mimetype.startsWith('image/');
    const resourceType = isImage ? 'image' : 'raw';
    const ext          = isImage
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
      logger.error(`Cloudinary proxy error: ${cloudRes.status} — publicId: ${attachment.publicId}`);
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

// ── PATCH /api/notices/:id/read — marcar como leído ───────────
exports.markAsRead = async (req, res, next) => {
  try {
    await Notice.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      { $addToSet: { readBy: req.user._id } }
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/notices/:id/unread — marcar como no leído ──────
exports.markAsUnread = async (req, res, next) => {
  try {
    await Notice.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      { $pull: { readBy: req.user._id } }
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
