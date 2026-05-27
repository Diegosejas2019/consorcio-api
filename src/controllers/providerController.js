const { Readable } = require('stream');
const mongoose = require('mongoose');
const Provider  = require('../models/Provider');
const Expense   = require('../models/Expense');
const logger    = require('../config/logger');
const { cloudinary } = require('../config/cloudinary');

// ── Helper: calcular estado documental de un proveedor ────────
function calcDocumentStatus(documents) {
  if (!documents?.length) return 'no_docs';
  const today = new Date();
  const in30  = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  let status  = 'valid';
  let hasAnyDoc = false;

  for (const doc of documents) {
    hasAnyDoc = true;
    if (!doc.expirationDate) continue;
    if (doc.expirationDate < today) return 'expired';
    if (doc.expirationDate < in30 && status !== 'expired') status = 'expiring_soon';
  }

  return hasAnyDoc ? status : 'no_docs';
}

function calcNextExpiration(documents) {
  if (!documents?.length) return null;
  const today = new Date();
  let nearest = null;
  for (const doc of documents) {
    if (!doc.expirationDate || doc.expirationDate < today) continue;
    if (!nearest || doc.expirationDate < nearest) nearest = doc.expirationDate;
  }
  return nearest;
}

function buildDocWarnings(documents) {
  const warnings = [];
  const today = new Date();
  const in30  = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  for (const doc of documents || []) {
    if (!doc.expirationDate) continue;
    const label = doc.title || doc.filename || 'Documento';
    if (doc.expirationDate < today) {
      warnings.push(`${label} vencido el ${doc.expirationDate.toLocaleDateString('es-AR')}`);
    } else if (doc.expirationDate < in30) {
      const dias = Math.ceil((doc.expirationDate - today) / (1000 * 60 * 60 * 24));
      warnings.push(`${label} vence en ${dias} día${dias !== 1 ? 's' : ''}`);
    }
  }
  return warnings;
}

// ── Campos permitidos en create/update ────────────────────────
const ALLOWED_FIELDS = ['name', 'serviceType', 'cuit', 'phone', 'email', 'active', 'status', 'contactName', 'notes', 'emergencyPhone'];

// ── GET /api/providers ────────────────────────────────────────
exports.getProviders = async (req, res, next) => {
  try {
    const filter = { organization: req.orgId };
    if (req.query.includeInactive !== 'true') filter.active = true;
    if (req.query.status)          filter.status = req.query.status;
    if (req.query.serviceType)     filter.serviceType = req.query.serviceType;
    if (req.query.documentStatus) {
      // Filtrar por estado documental requiere post-process en memoria (campo calculado)
      // Se aplica después del fetch
    }

    const providers = await Provider.find(filter).sort({ name: 1 }).select('-__v');

    const today = new Date();
    const in30  = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

    const enriched = providers.map(p => {
      const obj = p.toObject();
      obj.documentStatus  = calcDocumentStatus(p.documents);
      obj.nextExpiration  = calcNextExpiration(p.documents);
      obj.documentWarnings = buildDocWarnings(p.documents);
      return obj;
    });

    const docStatusFilter = req.query.documentStatus;
    const result = docStatusFilter
      ? enriched.filter(p => p.documentStatus === docStatusFilter)
      : enriched;

    res.json({ success: true, data: { providers: result } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/providers ───────────────────────────────────────
exports.createProvider = async (req, res, next) => {
  try {
    const data = { organization: req.orgId, createdBy: req.user._id };
    ALLOWED_FIELDS.forEach((f) => { if (req.body[f] !== undefined) data[f] = req.body[f]; });

    if (req.files?.length) {
      data.documents = req.files.map((f, i) => ({
        url:            f.path,
        publicId:       f.filename,
        filename:       f.originalname,
        mimetype:       f.mimetype,
        size:           f.size,
        title:          req.body[`docTitle_${i}`] || req.body.docTitle || '',
        category:       req.body[`docCategory_${i}`] || req.body.docCategory || 'other',
        expirationDate: req.body[`docExpiration_${i}`] || req.body.docExpiration || undefined,
      }));
    }

    const provider = await Provider.create(data);
    const obj = provider.toObject();
    obj.documentStatus = calcDocumentStatus(provider.documents);
    obj.nextExpiration = calcNextExpiration(provider.documents);

    logger.info(`Proveedor creado: ${provider.name} [org: ${req.orgId}]`);
    res.status(201).json({ success: true, data: { provider: obj } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/providers/:id ──────────────────────────────────
exports.updateProvider = async (req, res, next) => {
  try {
    const setFields = { updatedBy: req.user._id };
    ALLOWED_FIELDS.forEach((f) => { if (req.body[f] !== undefined) setFields[f] = req.body[f]; });

    const updateQuery = { $set: setFields };

    if (req.files?.length) {
      const newDocs = req.files.map((f, i) => ({
        url:            f.path,
        publicId:       f.filename,
        filename:       f.originalname,
        mimetype:       f.mimetype,
        size:           f.size,
        title:          req.body[`docTitle_${i}`] || req.body.docTitle || '',
        category:       req.body[`docCategory_${i}`] || req.body.docCategory || 'other',
        expirationDate: req.body[`docExpiration_${i}`] || req.body.docExpiration || undefined,
      }));
      updateQuery.$push = { documents: { $each: newDocs } };
    }

    const provider = await Provider.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      updateQuery,
      { new: true, runValidators: true }
    );
    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado.' });

    const obj = provider.toObject();
    obj.documentStatus = calcDocumentStatus(provider.documents);
    obj.nextExpiration = calcNextExpiration(provider.documents);

    res.json({ success: true, data: { provider: obj } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/providers/:id/document/:index — actualizar metadata de un doc ──
exports.updateDocumentMeta = async (req, res, next) => {
  try {
    const provider = await Provider.findOne({ _id: req.params.id, organization: req.orgId });
    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado.' });

    const idx = parseInt(req.params.index, 10);
    if (!provider.documents?.[idx]) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });

    const { title, category, expirationDate } = req.body;
    if (title !== undefined)          provider.documents[idx].title = title;
    if (category !== undefined)       provider.documents[idx].category = category;
    if (expirationDate !== undefined) provider.documents[idx].expirationDate = expirationDate || null;

    provider.markModified('documents');
    await provider.save();

    const obj = provider.toObject();
    obj.documentStatus = calcDocumentStatus(provider.documents);
    obj.nextExpiration = calcNextExpiration(provider.documents);

    res.json({ success: true, data: { provider: obj } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/providers/:id/details ───────────────────────────
exports.getProviderDetails = async (req, res, next) => {
  try {
    const provider = await Provider.findOne({ _id: req.params.id, organization: req.orgId }).select('-__v');
    if (!provider) return res.status(404).json({ success: false, message: 'Proveedor no encontrado.' });

    const today     = new Date();
    const in30      = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    const yearStart = new Date(today.getFullYear(), 0, 1);

    // Documentos con estado individual
    const documents = (provider.documents || []).map((doc, i) => {
      let docStatus = 'no_expiration';
      if (doc.expirationDate) {
        if (doc.expirationDate < today) docStatus = 'expired';
        else if (doc.expirationDate < in30) docStatus = 'expiring_soon';
        else docStatus = 'valid';
      }
      return { ...doc.toObject?.() ?? doc, index: i, docStatus };
    });

    const documentStatus = calcDocumentStatus(provider.documents);
    const warnings       = buildDocWarnings(provider.documents);

    // Resumen de gastos
    const provId = provider._id;
    const [allExpenses, yearExpenses, pendingExpenses, lastExpense] = await Promise.all([
      Expense.countDocuments({ organization: req.orgId, provider: provId, isActive: { $ne: false } }),
      Expense.aggregate([
        { $match: { organization: req.orgId, provider: provId, isActive: { $ne: false }, date: { $gte: yearStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Expense.countDocuments({ organization: req.orgId, provider: provId, isActive: { $ne: false }, status: { $ne: 'paid' } }),
      Expense.findOne({ organization: req.orgId, provider: provId, isActive: { $ne: false } }).sort({ date: -1 }).select('date amount description status'),
    ]);

    const [totalHistorico] = await Expense.aggregate([
      { $match: { organization: req.orgId, provider: provId, isActive: { $ne: false } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    const expenseSummary = {
      totalHistorico:  totalHistorico?.total ?? 0,
      totalAnioActual: yearExpenses[0]?.total ?? 0,
      cantidadGastos:  allExpenses,
      ultimoGasto:     lastExpense ?? null,
      pendientes:      pendingExpenses,
    };

    // Últimos 10 gastos
    const recentExpenses = await Expense.find({ organization: req.orgId, provider: provId, isActive: { $ne: false } })
      .sort({ date: -1 })
      .limit(10)
      .select('date amount description status category expenseType');

    res.json({
      success: true,
      data: {
        provider:       provider.toObject(),
        documents,
        documentStatus,
        warnings,
        expenseSummary,
        recentExpenses,
      },
    });
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
