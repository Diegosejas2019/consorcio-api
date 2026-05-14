const ADMIN_ROLE_LABELS = {
  owner_admin: 'Administrador principal',
  read_only: 'Solo lectura',
  billing_manager: 'Cobranzas',
  communications_manager: 'Reclamos y avisos',
};

const READ_PERMISSIONS = [
  'dashboard.read',
  'owners.read',
  'payments.read',
  'debt.read',
  'paymentPlans.read',
  'receipts.read',
  'expenses.read',
  'extraordinaryExpenses.read',
  'claims.read',
  'notices.read',
  'settings.read',
  'admins.read',
  'reports.read',
  'units.read',
  'providers.read',
  'employees.read',
  'salaries.read',
  'documents.read',
  'votes.read',
  'visits.read',
  'reservations.read',
  'spaces.read',
];

const ALL_PERMISSIONS = [
  ...READ_PERMISSIONS,
  'owners.create',
  'owners.update',
  'owners.delete',
  'payments.register',
  'payments.approve',
  'payments.cancel',
  'payments.remind',
  'debt.create',
  'debt.cancel',
  'paymentPlans.create',
  'paymentPlans.approve',
  'paymentPlans.cancel',
  'paymentPlans.registerPayment',
  'expenses.create',
  'expenses.update',
  'expenses.delete',
  'extraordinaryExpenses.create',
  'extraordinaryExpenses.update',
  'extraordinaryExpenses.delete',
  'claims.respond',
  'claims.close',
  'claims.delete',
  'notices.create',
  'notices.update',
  'notices.delete',
  'receipts.download',
  'settings.update',
  'admins.create',
  'admins.update',
  'admins.disable',
  'units.create',
  'units.update',
  'units.delete',
  'providers.create',
  'providers.update',
  'providers.delete',
  'employees.create',
  'employees.update',
  'employees.delete',
  'salaries.create',
  'salaries.update',
  'salaries.delete',
  'documents.create',
  'documents.update',
  'documents.delete',
  'votes.create',
  'votes.update',
  'votes.delete',
  'votes.close',
  'visits.update',
  'visits.delete',
  'reservations.update',
  'reservations.delete',
  'spaces.create',
  'spaces.update',
  'spaces.delete',
];

const ROLE_PERMISSIONS = {
  owner_admin: ALL_PERMISSIONS,
  read_only: READ_PERMISSIONS,
  billing_manager: [
    'dashboard.read',
    'owners.read',
    'owners.create',
    'owners.update',
    'units.read',
    'payments.read',
    'payments.register',
    'payments.approve',
    'payments.cancel',
    'debt.read',
    'debt.create',
    'debt.cancel',
    'receipts.read',
    'receipts.download',
    'paymentPlans.read',
    'paymentPlans.create',
    'paymentPlans.approve',
    'paymentPlans.cancel',
    'paymentPlans.registerPayment',
    'reports.read',
  ],
  communications_manager: [
    'dashboard.read',
    'owners.read',
    'claims.read',
    'claims.respond',
    'claims.close',
    'notices.read',
    'notices.create',
    'notices.update',
  ],
};

const ADMIN_ROLES = Object.keys(ROLE_PERMISSIONS);

function normalizeAdminRole(membership) {
  if (!membership || membership.role !== 'admin') return null;
  return membership.adminRole || 'owner_admin';
}

function getEffectivePermissions(membership) {
  const adminRole = normalizeAdminRole(membership);
  if (!adminRole) return [];

  const base = ROLE_PERMISSIONS[adminRole] || [];
  const custom = Array.isArray(membership.permissions) ? membership.permissions : [];
  return [...new Set([...base, ...custom])].sort();
}

function hasPermission(membership, permission) {
  return getEffectivePermissions(membership).includes(permission);
}

module.exports = {
  ADMIN_ROLES,
  ADMIN_ROLE_LABELS,
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  getEffectivePermissions,
  hasPermission,
  normalizeAdminRole,
};
