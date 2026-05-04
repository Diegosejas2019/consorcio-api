const { Readable } = require('stream');
const Employee = require('../models/Employee');
const Salary   = require('../models/Salary');
const logger   = require('../config/logger');
const { cloudinary } = require('../config/cloudinary');

const ROLE_LABELS = {
  security:    'Seguridad',
  cleaning:    'Limpieza',
  admin:       'Administración',
  maintenance: 'Mantenimiento',
  other:       'Otro',
};

const mapUploadedDocuments = (files = []) => files.map(f => ({
  url:      f.path,
  publicId: f.filename,
  filename: f.originalname,
  mimetype: f.mimetype,
  size:     f.size,
}));

// ── GET /api/employees ────────────────────────────────────────
exports.getEmployees = async (req, res, next) => {
  try {
    const { search, role, isActive } = req.query;

    const filter = { organization: req.orgId };
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ name: re }, { documentNumber: re }];
    }

    const employees = await Employee.find(filter).sort({ name: 1 }).select('-__v');

    res.json({ success: true, data: { employees } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/employees ───────────────────────────────────────
exports.createEmployee = async (req, res, next) => {
  try {
    const allowed = ['name', 'documentNumber', 'phone', 'email', 'role', 'customRole', 'startDate', 'endDate', 'notes'];
    const data = { organization: req.orgId, createdBy: req.user._id };
    allowed.forEach(f => { if (req.body[f] !== undefined) data[f] = req.body[f]; });
    if (req.files?.length) data.documents = mapUploadedDocuments(req.files);

    const employee = await Employee.create(data);
    logger.info(`Empleado creado: ${employee.name} [org: ${req.orgId}]`);
    res.status(201).json({ success: true, data: { employee } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/employees/:id ────────────────────────────────────
exports.getEmployee = async (req, res, next) => {
  try {
    const employee = await Employee.findOne({ _id: req.params.id, organization: req.orgId }).select('-__v');
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });
    res.json({ success: true, data: { employee } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/employees/:id ──────────────────────────────────
exports.updateEmployee = async (req, res, next) => {
  try {
    const allowed = ['name', 'documentNumber', 'phone', 'email', 'role', 'customRole', 'startDate', 'endDate', 'notes', 'isActive'];
    const setFields = { updatedBy: req.user._id };
    allowed.forEach(f => { if (req.body[f] !== undefined) setFields[f] = req.body[f]; });
    const updateQuery = { $set: setFields };
    if (req.files?.length) {
      updateQuery.$push = { documents: { $each: mapUploadedDocuments(req.files) } };
    }

    const employee = await Employee.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      updateQuery,
      { new: true, runValidators: true }
    ).select('-__v');

    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });

    res.json({ success: true, data: { employee } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/employees/:id (soft delete) ───────────────────
exports.deleteEmployee = async (req, res, next) => {
  try {
    const employee = await Employee.findOne({ _id: req.params.id, organization: req.orgId });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });
    if (!employee.isActive) return res.status(400).json({ success: false, message: 'El empleado ya está dado de baja.' });

    const pendingSalary = await Salary.findOne({ employee: employee._id, organization: req.orgId, status: 'pending' });
    if (pendingSalary) {
      return res.status(400).json({ success: false, message: 'No se puede dar de baja un empleado con sueldos pendientes de pago.' });
    }

    employee.isActive  = false;
    employee.endDate   = employee.endDate || new Date();
    employee.updatedBy = req.user._id;
    await employee.save();

    logger.info(`Empleado dado de baja: ${employee.name} [org: ${req.orgId}]`);
    res.json({ success: true, message: 'Empleado dado de baja correctamente.' });
  } catch (err) {
    next(err);
  }
};

// â”€â”€ GET /api/employees/:id/document/:index â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.getDocument = async (req, res, next) => {
  try {
    const employee = await Employee.findOne({ _id: req.params.id, organization: req.orgId });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });

    const idx = parseInt(req.params.index, 10);
    const doc = employee.documents?.[idx];
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
      logger.error(`Cloudinary proxy error: ${cloudRes.status} - publicId: ${doc.publicId}`);
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

// â”€â”€ DELETE /api/employees/:id/document/:index â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.deleteDocument = async (req, res, next) => {
  try {
    const employee = await Employee.findOne({ _id: req.params.id, organization: req.orgId });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });

    const idx = parseInt(req.params.index, 10);
    const doc = employee.documents?.[idx];
    if (!doc) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });

    if (doc.publicId) {
      const resType = doc.mimetype?.startsWith('image/') ? 'image' : 'raw';
      await cloudinary.uploader.destroy(doc.publicId, { resource_type: resType }).catch(() => {});
    }

    employee.documents.splice(idx, 1);
    employee.updatedBy = req.user._id;
    await employee.save();

    res.json({ success: true, message: 'Documento eliminado.' });
  } catch (err) {
    next(err);
  }
};

exports.ROLE_LABELS = ROLE_LABELS;
