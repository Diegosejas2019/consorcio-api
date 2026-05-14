const { getEffectivePermissions, normalizeAdminRole } = require('../utils/adminPermissions');

function deny(res) {
  return res.status(403).json({
    success: false,
    message: 'No tenés permisos para realizar esta acción.',
  });
}

function can(req, permission) {
  if (req.user?.role === 'super_admin') return true;
  if (req.user?.role !== 'admin') return false;
  if (!req.membership) return true;
  return getEffectivePermissions(req.membership).includes(permission);
}

exports.requirePermission = (permission) => (req, res, next) => {
  if (!can(req, permission)) return deny(res);
  next();
};

exports.requireAnyPermission = (permissions = []) => (req, res, next) => {
  if (permissions.some(permission => can(req, permission))) return next();
  return deny(res);
};

exports.requireAdminRole = (adminRole) => (req, res, next) => {
  if (req.user?.role === 'super_admin') return next();
  if (req.user?.role !== 'admin') return deny(res);
  if (!req.membership) return next();
  if (normalizeAdminRole(req.membership) !== adminRole) return deny(res);
  next();
};

exports.requirePermissionForAdmin = (permission) => (req, res, next) => {
  if (req.user?.role !== 'admin') return next();
  if (!can(req, permission)) return deny(res);
  next();
};

exports.can = can;
