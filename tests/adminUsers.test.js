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
const Organization = require('../src/models/Organization');
const Unit = require('../src/models/Unit');
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

    const invite = await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${readOnly.token}`)
      .send({ mode: 'new_user', name: 'Sin Permiso', email: 'sin-permiso@test.com', role: 'read_only' });
    expect(invite.status).toBe(403);
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

  test('busca propietarios por nombre, email y unidad dentro de la organizacion', async () => {
    const { user, token, orgId } = await createAdminWithToken();
    await addAdminMembership(user._id, orgId, 'owner_admin');

    const owner = await User.create({
      name: 'Carla Propietaria',
      email: 'carla@test.com',
      password: 'password123',
      role: 'owner',
      organization: orgId,
      isActive: true,
    });
    const membership = await OrganizationMember.create({
      user: owner._id,
      organization: orgId,
      role: 'owner',
      isActive: true,
    });
    await Unit.create({ organization: orgId, owner: owner._id, name: 'Lote Norte', active: true });

    const otherOrg = await Organization.create({ name: 'Otra organizacion', slug: 'otra-organizacion', type: 'building' });
    const otherOwner = await User.create({
      name: 'Carla Externa',
      email: 'carla-externa@test.com',
      password: 'password123',
      role: 'owner',
      organization: otherOrg._id,
      isActive: true,
    });
    await OrganizationMember.create({
      user: otherOwner._id,
      organization: otherOrg._id,
      role: 'owner',
      isActive: true,
    });
    await Unit.create({ organization: otherOrg._id, owner: otherOwner._id, name: 'Lote Norte', active: true });

    const res = await request(app)
      .get('/api/admin/owners/search?query=norte')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.owners).toHaveLength(1);
    expect(res.body.data.owners[0]).toEqual(expect.objectContaining({
      ownerId: owner._id.toString(),
      membershipId: membership._id.toString(),
      name: 'Carla Propietaria',
      email: 'carla@test.com',
      primaryUnit: 'Lote Norte',
      isAdminActive: false,
    }));
  });

  test('asocia propietario existente como administrador sin duplicar usuario ni modificar password', async () => {
    const { user, token, orgId } = await createAdminWithToken();
    await addAdminMembership(user._id, orgId, 'owner_admin');

    const owner = await User.create({
      name: 'Propietario Admin',
      email: 'propietario-admin@test.com',
      password: 'password123',
      role: 'owner',
      organization: orgId,
      isActive: true,
      mustChangePassword: false,
    });
    await OrganizationMember.create({
      user: owner._id,
      organization: orgId,
      role: 'owner',
      isActive: true,
    });
    const before = await User.findById(owner._id).select('+password mustChangePassword');

    const res = await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'existing_owner', ownerId: owner._id, role: 'billing_manager' });

    expect(res.status).toBe(201);
    expect(res.body.data.admin.role).toBe('billing_manager');
    const after = await User.findById(owner._id).select('+password mustChangePassword');
    expect(after.password).toBe(before.password);
    expect(after.mustChangePassword).toBe(false);
    expect(await User.countDocuments({ email: 'propietario-admin@test.com' })).toBe(1);
    expect(emailService.sendAdminWelcome).not.toHaveBeenCalled();

    const memberships = await OrganizationMember.find({ user: owner._id, organization: orgId });
    expect(memberships.map((membership) => membership.role).sort()).toEqual(['admin', 'owner']);
    expect(memberships.find((membership) => membership.role === 'admin').adminRole).toBe('billing_manager');
  });

  test('rechaza propietario de otra organizacion y admin duplicado', async () => {
    const { user, token, orgId } = await createAdminWithToken();
    await addAdminMembership(user._id, orgId, 'owner_admin');

    const otherOrg = await Organization.create({ name: 'Organizacion externa', slug: 'organizacion-externa', type: 'building' });
    const externalOwner = await User.create({
      name: 'Owner Externo',
      email: 'owner-externo@test.com',
      password: 'password123',
      role: 'owner',
      organization: otherOrg._id,
      isActive: true,
    });
    await OrganizationMember.create({
      user: externalOwner._id,
      organization: otherOrg._id,
      role: 'owner',
      isActive: true,
    });

    const externalRes = await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'existing_owner', ownerId: externalOwner._id, role: 'billing_manager' });

    expect(externalRes.status).toBe(404);
    expect(externalRes.body.message).toBe('El propietario seleccionado no pertenece a esta organización.');

    const ownerAdmin = await User.create({
      name: 'Owner Ya Admin',
      email: 'owner-ya-admin@test.com',
      password: 'password123',
      role: 'owner',
      organization: orgId,
      isActive: true,
    });
    await OrganizationMember.create({
      user: ownerAdmin._id,
      organization: orgId,
      role: 'owner',
      isActive: true,
    });
    await addAdminMembership(ownerAdmin._id, orgId, 'read_only');

    const duplicateRes = await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'existing_owner', ownerId: ownerAdmin._id, role: 'billing_manager' });

    expect(duplicateRes.status).toBe(409);
    expect(duplicateRes.body.message).toBe('Este usuario ya es administrador de la organización.');
  });
});
