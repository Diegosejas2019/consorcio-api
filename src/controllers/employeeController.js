const crypto   = require('crypto');
const { Readable } = require('stream');
const Employee = require('../models/Employee');
const Salary   = require('../models/Salary');
const PayrollLiquidation = require('../models/PayrollLiquidation');
const User     = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const logger   = require('../config/logger');
const { cloudinary } = require('../config/cloudinary');
const { sendAdminWelcome } = require('../services/emailService');

function tempPassword() {
  return `Temp${crypto.randomBytes(4).toString('hex')}!`;
}

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
    const { search, role, isActive, isOnLeave, unlinked } = req.query;

    const filter = { organization: req.orgId };
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (isOnLeave !== undefined) filter.isOnLeave = isOnLeave === 'true';
    if (unlinked === 'true') filter.userId = null;

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
    const allowed = ['name', 'documentNumber', 'phone', 'email', 'role', 'customRole', 'startDate', 'endDate', 'notes', 'schedule', 'isOnLeave', 'leaveNote'];
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
    const allowed = ['name', 'documentNumber', 'phone', 'email', 'role', 'customRole', 'startDate', 'endDate', 'notes', 'isActive', 'schedule', 'isOnLeave', 'leaveNote'];
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

    const pendingSalary = await Salary.findOne({ employee: employee._id, organization: req.orgId, status: { $in: ['pending', 'partially_paid'] } });
    if (pendingSalary) {
      return res.status(400).json({ success: false, message: 'No se puede dar de baja un empleado con sueldos pendientes de pago o parcialmente pagados.' });
    }

    const pendingLiquidation = await PayrollLiquidation.findOne({
      employee: employee._id,
      organization: req.orgId,
      status: { $in: ['draft', 'calculated', 'approved'] },
    });
    if (pendingLiquidation) {
      return res.status(400).json({ success: false, message: 'No se puede dar de baja al empleado. Tiene liquidaciones de haberes pendientes o aprobadas.' });
    }

    employee.isActive  = false;
    employee.endDate   = employee.endDate || new Date();
    employee.updatedBy = req.user._id;
    await employee.save();

    if (req.query.revokeAccess === 'true' && employee.userId) {
      await OrganizationMember.findOneAndUpdate(
        { user: employee.userId, organization: req.orgId, role: 'admin' },
        { $set: { isActive: false, disabledAt: new Date(), disabledBy: req.user._id } }
      );
    }

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

// ── POST /api/employees/:id/create-access ─────────────────────
exports.createAccess = async (req, res, next) => {
  try {
    const employee = await Employee.findOne({ _id: req.params.id, organization: req.orgId });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });
    if (!employee.isActive) return res.status(400).json({ success: false, message: 'El empleado está dado de baja.' });
    if (employee.role !== 'security') return res.status(400).json({ success: false, message: 'Solo se puede crear acceso de portería para empleados de seguridad.' });
    if (employee.userId) return res.status(409).json({ success: false, message: 'Este empleado ya tiene acceso al portal.' });

    const email = (req.body.email || employee.email || '').trim().toLowerCase();
    const name  = (req.body.name  || employee.name  || '').trim();
    if (!email) return res.status(400).json({ success: false, message: 'El empleado no tiene email registrado. Agregá un email primero.' });

    let user = await User.findOne({ email });
    let rawPassword = null;
    let isNewUser = false;

    if (!user) {
      rawPassword = tempPassword();
      user = await User.create({
        name,
        email,
        password: rawPassword,
        role: 'admin',
        organization: req.orgId,
        mustChangePassword: true,
        temporaryPasswordCreatedAt: new Date(),
        createdBy: req.user._id,
      });
      isNewUser = true;
    } else if (!user.isActive) {
      return res.status(400).json({ success: false, message: 'El usuario con ese email está desactivado. Reactivalo primero desde soporte.' });
    }

    const existingMembership = await OrganizationMember.findOne({
      user: user._id,
      organization: req.orgId,
      role: 'admin',
    });

    if (existingMembership?.isActive) {
      return res.status(409).json({ success: false, message: 'Ese email ya corresponde a un administrador activo en esta organización.' });
    }

    const membership = existingMembership || new OrganizationMember({
      user: user._id,
      organization: req.orgId,
      role: 'admin',
      createdBy: req.user._id,
    });
    membership.adminRole = 'security_guard';
    membership.isActive  = true;
    membership.deactivatedByOrganization = false;
    membership.disabledAt = undefined;
    membership.disabledBy = undefined;
    if (existingMembership) membership.reactivatedAt = new Date();
    membership.updatedBy = req.user._id;
    await membership.save();

    employee.userId    = user._id;
    employee.updatedBy = req.user._id;
    await employee.save();

    if (isNewUser) {
      sendAdminWelcome({ name, email }, rawPassword, req.org?.name || 'tu organización').catch(() => {});
    }

    logger.info(`Acceso portal creado: ${employee.name} → ${email} [org: ${req.orgId}]`);
    res.status(201).json({
      success: true,
      message: isNewUser
        ? 'Acceso creado. Se envió el email con la contraseña temporal.'
        : 'Acceso vinculado correctamente.',
      data: { userId: user._id, email: user.email, isNewUser },
    });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/employees/:id/link-user ────────────────────────
exports.linkUser = async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId es obligatorio.' });

    const employee = await Employee.findOne({ _id: req.params.id, organization: req.orgId });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });
    if (employee.userId) return res.status(409).json({ success: false, message: 'Este empleado ya tiene un usuario vinculado.' });

    const membership = await OrganizationMember.findOne({
      user: userId,
      organization: req.orgId,
      role: 'admin',
      adminRole: 'security_guard',
    });
    if (!membership) return res.status(404).json({ success: false, message: 'No se encontró un vigilador con ese userId en esta organización.' });

    employee.userId    = userId;
    employee.updatedBy = req.user._id;
    await employee.save();

    res.json({ success: true, message: 'Usuario vinculado correctamente.' });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/employees/:id/unlink-user ─────────────────────
exports.unlinkUser = async (req, res, next) => {
  try {
    const employee = await Employee.findOne({ _id: req.params.id, organization: req.orgId });
    if (!employee) return res.status(404).json({ success: false, message: 'Empleado no encontrado.' });
    if (!employee.userId) return res.status(400).json({ success: false, message: 'Este empleado no tiene usuario vinculado.' });

    employee.userId    = null;
    employee.updatedBy = req.user._id;
    await employee.save();

    res.json({ success: true, message: 'Vínculo removido correctamente.' });
  } catch (err) {
    next(err);
  }
};

exports.ROLE_LABELS = ROLE_LABELS;
