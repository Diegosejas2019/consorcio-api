const SUPER_ADMIN_ROLE = 'super_admin';
const LEGACY_SUPERADMIN_ROLE = 'superadmin';

function normalizeRole(role) {
  return role === LEGACY_SUPERADMIN_ROLE ? SUPER_ADMIN_ROLE : role;
}

function isSuperAdminRole(role) {
  return normalizeRole(role) === SUPER_ADMIN_ROLE;
}

function expandRoles(roles) {
  const expanded = new Set();
  roles.forEach((role) => {
    expanded.add(role);
    if (role === SUPER_ADMIN_ROLE || role === LEGACY_SUPERADMIN_ROLE) {
      expanded.add(SUPER_ADMIN_ROLE);
      expanded.add(LEGACY_SUPERADMIN_ROLE);
    }
  });
  return Array.from(expanded);
}

module.exports = {
  SUPER_ADMIN_ROLE,
  LEGACY_SUPERADMIN_ROLE,
  normalizeRole,
  isSuperAdminRole,
  expandRoles,
};
