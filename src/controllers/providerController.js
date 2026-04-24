const { Readable } = require('stream');
const Provider  = require('../models/Provider');
const logger    = require('../config/logger');
const { cloudinary } = require('../config/cloudinary');

// ── GET /api/providers ────────────────────────────────────────
exports.getProviders = async (req, res, next) => {
  try {
    const filter = { organization: req.orgId };
    if (req.query.includeInactive !== 'true') filter.active = true;

    const providers = await Provider.find(filter).sort({ name: 1 }).select('-__v');
    res.json({ success: true, data: { providers } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/providers ───────────────────────────────────────
exports.createProvider = async (req, res, next) => {
  try {
    const allowed = ['name', 'serviceType', 'cuit', 'phone', 'email'];
    const data    = { organization: req.orgId };
    allowed.forEach((f) => { if (req.body[f] !== undefined) data[f] = req.body[f]; });

    if (req.files?.length) {
      data.documents = req.files.map(f => ({
        url:      f.path,
        publicId: f.filename,
        filename: f.originalname,
        mimetype: f.mimetype,
        size:     f.size,
      }));
    }

    const provider = await Provider.create(data);
    logger.info(`Proveedor creado: ${provider.name} [org: ${req.orgId}]`);
    res.status(201).json({ success: true, data: { provider } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/providers/:id ──────────────────────────────────
exports.updateProvider = async (req, res, next) => {
  try {
    const allowed = ['name', 'serviceType', 'cuit', 'phone', 'email', 'active'];
    const setFields = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) setFields[f] = req.body[f]; });

    const updateQuery = { $set: setFields };

    if (req.files?.length) {
      const newDocs = req.files.map(f => ({
        url:      f.path,
        publicId: f.filename,
        filename: f.originalname,
        mimetype: f.mimetype,
        size:     f.size,
      }));
      updateQuery.$push = { documents: { $each: newDocs } };
    }

    const provider = await Provider.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      updateQuery,
      { new: true, runValidators: true }
    );
    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado.' });

    res.json({ success: true, data: { provider } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/providers/:id/document/:index ────────────────────
exports.getDocument = async (req, res, next) => {
  try {
    const provider = await Provider.findOne({ _id: req.params.id, organization: req.orgId });
    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado.' });

    const idx = parseInt(req.params.index, 10);
    const doc = provider.documents?.[idx];
    if (!doc?.publicId) {
      return res.status(404).json({ success: false, message: 'Documento no encontrado.' });
    }

    const mimetype     = doc.mimetype || 'application/pdf';
    const isImage      = mimetype.startsWith('image/');
    const resourceType = isImage ? 'image' : 'raw';
    const ext          = isImage
      ? (mimetype.split('/')[1] === 'jpeg' ? 'jpg' : mimetype.split('/')[1])
      : 'pdf';
    const deliveryType = doc.url?.includes('/authenticated/') ? 'authenticated' : 'upload';

    const signedUrl = cloudinary.utils.private_download_url(
      doc.publicId,
      ext,
      {
        resource_type: resourceType,
        type:          deliveryType,
        expires_at:    Math.floor(Date.now() / 1000) + 120,
      }
    );

    const cloudRes = await fetch(signedUrl);
    if (!cloudRes.ok) {
      logger.error(`Cloudinary proxy error: ${cloudRes.status} — publicId: ${doc.publicId}`);
      return res.status(502).json({ success: false, message: 'No se pudo obtener el documento desde Cloudinary.' });
    }

    const filename = (doc.filename || `documento.${ext}`).replace(/"/g, '');
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${filename}"`);

    const contentLength = cloudRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    Readable.fromWeb(cloudRes.body).pipe(res);
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/providers/:id/document/:index ─────────────────
exports.deleteDocument = async (req, res, next) => {
  try {
    const provider = await Provider.findOne({ _id: req.params.id, organization: req.orgId });
    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado.' });

    const idx = parseInt(req.params.index, 10);
    const doc = provider.documents?.[idx];
    if (!doc) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });

    if (doc.publicId) {
      const resType = doc.mimetype?.startsWith('image/') ? 'image' : 'raw';
      await cloudinary.uploader.destroy(doc.publicId, { resource_type: resType }).catch(() => {});
    }

    provider.documents.splice(idx, 1);
    await provider.save();

    res.json({ success: true, message: 'Documento eliminado.' });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/providers/:id — soft delete ───────────────────
exports.deleteProvider = async (req, res, next) => {
  try {
    const provider = await Provider.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      { active: false },
      { new: true }
    );
    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado.' });

    logger.info(`Proveedor desactivado: ${provider.name} [org: ${req.orgId}]`);
    res.json({ success: true, message: 'Proveedor desactivado correctamente.' });
  } catch (err) {
    next(err);
  }
};
