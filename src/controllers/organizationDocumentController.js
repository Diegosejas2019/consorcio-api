const { Readable } = require('stream');
const OrganizationDocument = require('../models/OrganizationDocument');
const logger = require('../config/logger');
const { cloudinary } = require('../config/cloudinary');

const ALLOWED_FIELDS = ['title', 'description', 'category', 'visibility'];

function buildFileData(file) {
  if (!file) return undefined;
  return {
    url:      file.path,
    publicId: file.filename,
    filename: file.originalname,
    mimetype: file.mimetype,
    size:     file.size,
  };
}

function canAccessDocument(req, document) {
  return req.accessType !== 'owner' || document.visibility === 'owners';
}

function buildDocumentFilter(req) {
  const filter = { organization: req.orgId, isActive: { $ne: false } };

  if (req.accessType === 'owner') {
    filter.visibility = 'owners';
  } else if (req.query.visibility) {
    filter.visibility = req.query.visibility;
  }

  if (req.query.category) filter.category = req.query.category;
  if (req.query.search?.trim()) {
    const search = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { title: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
    ];
  }

  return filter;
}

async function findScopedDocument(req) {
  return OrganizationDocument.findOne({
    _id:          req.params.id,
    organization: req.orgId,
    isActive:     { $ne: false },
  }).select('-__v');
}

async function deleteCloudinaryFile(file) {
  if (!file?.publicId) return;
  const resourceType = file.mimetype?.startsWith('image/') ? 'image' : 'raw';
  await cloudinary.uploader.destroy(file.publicId, { resource_type: resourceType }).catch(() => {});
}

// GET /api/organization-documents
exports.getDocuments = async (req, res, next) => {
  try {
    const documents = await OrganizationDocument.find(buildDocumentFilter(req))
      .sort({ createdAt: -1 })
      .select('-__v');

    res.json({ success: true, data: { documents } });
  } catch (err) {
    next(err);
  }
};

// GET /api/organization-documents/:id
exports.getDocument = async (req, res, next) => {
  try {
    const document = await findScopedDocument(req);
    if (!document) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });
    if (!canAccessDocument(req, document)) {
      return res.status(403).json({ success: false, message: 'No tenes permisos para ver este documento.' });
    }

    res.json({ success: true, data: { document } });
  } catch (err) {
    next(err);
  }
};

// POST /api/organization-documents
exports.createDocument = async (req, res, next) => {
  try {
    if (!req.body.title?.trim()) {
      return res.status(400).json({ success: false, message: 'El titulo es obligatorio.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'El archivo es obligatorio.' });
    }

    const data = {
      organization: req.orgId,
      uploadedBy:   req.user._id,
      file:         buildFileData(req.file),
    };
    ALLOWED_FIELDS.forEach((field) => {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    });

    const document = await OrganizationDocument.create(data);
    logger.info(`Documento de organizacion creado: ${document.title} [org: ${req.orgId}]`);

    res.status(201).json({ success: true, data: { document } });
  } catch (err) {
    await deleteCloudinaryFile(buildFileData(req.file));
    next(err);
  }
};

// PATCH /api/organization-documents/:id
exports.updateDocument = async (req, res, next) => {
  try {
    const document = await findScopedDocument(req);
    if (!document) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });

    ALLOWED_FIELDS.forEach((field) => {
      if (req.body[field] !== undefined) document[field] = req.body[field];
    });

    const previousFile = document.file?.publicId ? document.file.toObject?.() || document.file : null;
    if (req.file) {
      document.file = buildFileData(req.file);
    }
    document.updatedBy = req.user._id;

    await document.save();

    if (req.file && previousFile?.publicId) {
      await deleteCloudinaryFile(previousFile);
    }

    res.json({ success: true, data: { document } });
  } catch (err) {
    await deleteCloudinaryFile(buildFileData(req.file));
    next(err);
  }
};

// DELETE /api/organization-documents/:id
exports.deleteDocument = async (req, res, next) => {
  try {
    const document = await findScopedDocument(req);
    if (!document) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });

    document.isActive = false;
    document.updatedBy = req.user._id;
    await document.save();

    logger.info(`Documento de organizacion eliminado: ${document._id} [org: ${req.orgId}]`);
    res.json({ success: true, message: 'Documento eliminado correctamente.' });
  } catch (err) {
    next(err);
  }
};

// GET /api/organization-documents/:id/download
exports.getDocumentUrl = async (req, res, next) => {
  try {
    const document = await findScopedDocument(req);
    if (!document) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });
    if (!canAccessDocument(req, document)) {
      return res.status(403).json({ success: false, message: 'No tenes permisos para descargar este documento.' });
    }
    if (!document.file?.publicId) {
      return res.status(404).json({ success: false, message: 'Este documento no tiene archivo adjunto.' });
    }

    const mimetype = document.file.mimetype || 'application/pdf';
    const isImage = mimetype.startsWith('image/');
    const resourceType = isImage ? 'image' : 'raw';
    const ext = isImage
      ? (mimetype.split('/')[1] === 'jpeg' ? 'jpg' : mimetype.split('/')[1])
      : 'pdf';
    const deliveryType = document.file.url?.includes('/authenticated/') ? 'authenticated' : 'upload';

    const signedUrl = cloudinary.utils.private_download_url(
      document.file.publicId,
      ext,
      {
        resource_type: resourceType,
        type:          deliveryType,
        expires_at:    Math.floor(Date.now() / 1000) + 120,
      }
    );

    const cloudRes = await fetch(signedUrl);
    if (!cloudRes.ok) {
      logger.error(`Cloudinary proxy error: ${cloudRes.status} - publicId: ${document.file.publicId}`);
      return res.status(502).json({ success: false, message: 'No se pudo obtener el documento desde Cloudinary.' });
    }

    const filename = (document.file.filename || `documento.${ext}`).replace(/"/g, '');
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${filename}"`);

    const contentLength = cloudRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    Readable.fromWeb(cloudRes.body).pipe(res);
  } catch (err) {
    next(err);
  }
};
