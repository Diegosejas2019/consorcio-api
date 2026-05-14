jest.mock('../src/services/emailService', () => ({
  sendAdminWelcome: jest.fn().mockResolvedValue(null),
}));

const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createAdminWithToken } = require('./helpers/factories');
const { signToken } = require('../src/middleware/auth');
const User = require('../src/models/User');
const OrganizationMember = require('../src/models/OrganizationMember');
const emailService = require('../src/services/emailService');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  jest.clearAllMocks();
  await dbHelper.clear();
});

async function addAdminMembership(userId, orgId, adminRole = 'owner_admin') {
  return OrganizationMember.create({
    user: userId,
    organization: orgId,
    role: 'admin',
    adminRole,
    isActive: true,
  });
}

async function createAdminInOrg(orgId, adminRole) {
  const user = await User.create({
    name: `Admin ${adminRole}`,
    email: `${adminRole}-${Date.now()}@test.com`,
    password: 'password123',
    role: 'admin',
    organization: orgId,
    isActive: true,
  });
  const membership = await addAdminMembership(user._id, orgId, adminRole);
  return {
    user,
    membership,
    token: signToken(user._id, { organizationId: orgId, role: 'admin', membershipId: membership._id }),
  };
}

describe('usuarios administradores y permisos internos', () => {
  test('devuelve permisos efectivos del administrador actual', async () => {
    const { user, token, orgId } = await createAdminWithToken();
    const membership = await addAdminMembership(user._id, orgId, 'billing_manager');
    const scopedToken = signToken(user._id, { organizationId: orgId, role: 'admin', membershipId: membership._id });

    const res = await request(app)
      .get('/api/admin/permissions/me')
      .set('Authorization', `Bearer ${scopedToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('billing_manager');
    expect(res.body.data.permissions).toEqual(expect.arrayContaining([
      'payments.read',
      'payments.register',
      'owners.update',
    ]));
    expect(res.body.data.permissions).not.toContain('admins.create');
  });

  test('invita un administrador nuevo con password temporal y membership admin', async () => {
    const { user, token, orgId } = await createAdminWithToken();
    await addAdminMembership(user._id, orgId, 'owner_admin');

    const res = await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'María López',
        email: 'maria-admin@test.com',
        role: 'billing_manager',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.admin.role).toBe('billing_manager');

    const invited = await User.findOne({ email: 'maria-admin@test.com' });
    expect(invited.role).toBe('admin');
    expect(invited.mustChangePassword).toBe(true);
    expect(invited.temporaryPasswordCreatedAt).toBeTruthy();

    const membership = await OrganizationMember.findOne({ user: invited._id, organization: orgId, role: 'admin' });
    expect(membership.adminRole).toBe('billing_manager');
    expect(emailService.sendAdminWelcome).toHaveBeenCalledTimes(1);
  });

  test('agrega un usuario existente sin modificar su password', async () => {
    const { user, token, orgId } = await createAdminWithToken();
    await addAdminMembership(user._id, orgId, 'owner_admin');

    const existing = await User.create({
      name: 'Admin Existente',
      email: 'admin-existente@test.com',
      password: 'password123',
      role: 'admin',
      organization: orgId,
      isActive: true,
    });
    const before = await User.findById(existing._id).select('+password');

    const res = await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Otro Nombre',
        email: 'admin-existente@test.com',
        role: 'communications_manager',
      });

    expect(res.status).toBe(201);
    const after = await User.findById(existing._id).select('+password');
    expect(after.password).toBe(before.password);
    expect(after.mustChangePassword).toBe(false);
    expect(emailService.sendAdminWelcome).not.toHaveBeenCalled();

    const membership = await OrganizationMember.findOne({ user: existing._id, organization: orgId, role: 'admin' });
    expect(membership.adminRole).toBe('communications_manager');
  });

  test('bloquea acciones no permitidas por rol', async () => {
    const { orgId } = await createAdminWithToken();
    const readOnly = await createAdminInOrg(orgId, 'read_only');
    const billing = await createAdminInOrg(orgId, 'billing_manager');
    const communications = await createAdminInOrg(orgId, 'communications_manager');

    const ownerCreate = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${readOnly.token}`)
      .send({ name: 'No Puede', email: 'no-puede@test.com' });
    expect(ownerCreate.status).toBe(403);
    expect(ownerCreate.body.message).toBe('No tenés permisos para realizar esta acción.');

    const adminList = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${billing.token}`);
    expect(adminList.status).toBe(403);

    const payments = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${communications.token}`);
    expect(payments.status).toBe(403);
  });

  test('no permite dejar la organización sin administrador principal activo', async () => {
    const { user, token, orgId } = await createAdminWithToken();
    await addAdminMembership(user._id, orgId, 'owner_admin');

    const res = await request(app)
      .patch(`/api/admin/users/${user._id}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'read_only' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('administrador principal');
  });
});
