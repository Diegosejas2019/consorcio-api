const { Readable }    = require('stream');
const Claim           = require('../models/Claim');
const firebaseService = require('../services/firebaseService');
const User            = require('../models/User');
const logger          = require('../config/logger');
const { cloudinary, deleteCloudinaryAttachments } = require('../config/cloudinary');

// ── GET /api/claims ───────────────────────────────────────────
exports.getClaims = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;

    const filter = { organization: req.orgId, isActive: { $ne: false } };
    if (req.user.role === 'owner') filter.owner = req.user._id;
    if (status) filter.status = status;

    const [claims, total] = await Promise.all([
      Claim.find(filter)
        .populate('owner', 'name unit email')
        .populate('resolvedBy', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-__v'),
      Claim.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { claims },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/claims — crear reclamo (owner) ──────────────────
exports.createClaim = async (req, res, next) => {
  try {
    const { category, title, body } = req.body;

    const claimData = { organization: req.orgId, owner: req.user._id, category, title, body };

    if (req.files?.length) {
      claimData.attachments = req.files.map(f => ({
        url:      f.path,
        publicId: f.filename,
        filename: f.originalname,
        mimetype: f.mimetype,
        size:     f.size,
      }));
    }

    const claim = await Claim.create(claimData);

    await claim.populate('owner', 'name unit email');

    // Notificar al admin de la misma organización
    const admins = await User.find({ organization: req.orgId, role: 'admin', isActive: true })
      .select('+fcmToken');
    const tokens = admins.filter(a => a.fcmToken).map(a => a.fcmToken);
    if (tokens.length > 0) {
      firebaseService.sendMulticast(tokens, {
        title: '📋 Nuevo reclamo',
        body:  `${claim.owner.name} (${claim.owner.unit || 'sin unidad'}): ${title}`,
        data:  { type: 'new_claim', claimId: claim._id.toString() },
      }).catch(err => logger.warn(`Push admin reclamo falló: ${err.message}`));
    }

    logger.info(`Reclamo creado: "${claim.title}" por ${req.user.name}`);
    res.status(201).json({ success: true, data: { claim } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/claims/:id/status — cambiar estado (admin) ─────
exports.updateStatus = async (req, res, next) => {
  try {
    const { status, adminNote } = req.body;

    const claim = await Claim.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name unit email fcmToken');
    if (!claim) return res.status(404).json({ success: false, message: 'Reclamo no encontrado.' });

    const prev = claim.status;
    claim.status    = status;
    claim.updatedBy = req.user._id;
    if (adminNote !== undefined) claim.adminNote = adminNote.trim();
    if (status === 'resolved' && prev !== 'resolved') {
      claim.resolvedBy = req.user._id;
      claim.resolvedAt = new Date();
    }
    await claim.save();

    if (status === 'resolved' && prev !== 'resolved') {
      firebaseService.sendToUser(claim.owner._id, {
        title: '✅ Reclamo resuelto',
        body:  `Tu reclamo "${claim.title}" fue marcado como resuelto.`,
        data:  { type: 'claim_resolved', claimId: claim._id.toString() },
      }).catch(err => logger.warn(`Push owner reclamo resuelto falló: ${err.message}`));
    }

    logger.info(`Reclamo ${claim._id} → ${status} por ${req.user.name}`);
    res.json({ success: true, data: { claim } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/claims/:id — eliminar (owner pendiente / admin) ─
exports.deleteClaim = async (req, res, next) => {
  try {
    const claim = await Claim.findOne({ _id: req.params.id, organization: req.orgId, isActive: { $ne: false } });
    if (!claim) return res.status(404).json({ success: false, message: 'Reclamo no encontrado.' });

    if (req.user.role === 'owner') {
      if (claim.owner.toString() !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Acceso denegado.' });
      }
      if (claim.status !== 'open') {
        return res.status(400).json({ success: false, message: 'Solo podés eliminar reclamos abiertos.' });
      }
    }

    if (claim.attachments?.length) {
      await deleteCloudinaryAttachments(claim.attachments);
    }

    claim.isActive  = false;
    claim.deletedAt = new Date();
    claim.deletedBy = req.user._id;
    await claim.save();

    logger.info('Claim soft deleted', { id: claim._id, userId: req.user._id });
    res.json({ success: true, message: 'Reclamo eliminado.' });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/claims/:id/attachment/:index ─────────────────────
exports.getAttachment = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id, organization: req.orgId, isActive: { $ne: false } };
    if (req.user.role === 'owner') filter.owner = req.user._id;

    const claim = await Claim.findOne(filter);
    if (!claim) return res.status(404).json({ success: false, message: 'Reclamo no encontrado.' });

    const idx        = parseInt(req.params.index, 10);
    const attachment = claim.attachments?.[idx];
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
