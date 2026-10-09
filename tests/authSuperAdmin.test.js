jest.mock('../src/services/emailService', () => ({
  sendAdminWelcome: jest.fn().mockResolvedValue(null),
}));

const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const OrganizationMember = require('../src/models/OrganizationMember');
const emailService = require('../src/services/emailService');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  jest.clearAllMocks();
  await dbHelper.clear();
});

describe('SuperAdmin auth', () => {
  test('super_admin inicia sesion sin seleccionar organizacion y ve organizaciones globales', async () => {
    await Organization.create({ name: 'Org Uno', slug: 'org-uno', businessType: 'consorcio' });
    await User.create({
      name: 'SaaS Root',
      email: 'root@gestionar.test',
      password: 'Admin2025!',
      role: 'super_admin',
      isActive: true,
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'root@gestionar.test', password: 'Admin2025!' });

    expect(login.status).toBe(200);
    expect(login.body.requiresOrganizationSelection).toBeUndefined();
    expect(login.body.data.user.role).toBe('super_admin');
    expect(login.body.token).toBeTruthy();

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('super_admin');
    expect(me.body.data.membership).toBeNull();

    const orgs = await request(app)
      .get('/api/organizations')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(orgs.status).toBe(200);
    expect(orgs.body.data.organizations).toHaveLength(1);
  });

  test('super_admin no usa select-organization aunque tenga memberships legacy', async () => {
    const org = await Organization.create({ name: 'Org Legacy', slug: 'org-legacy', businessType: 'consorcio' });
    const user = await User.create({
      name: 'Legacy Root',
      email: 'legacy-root@gestionar.test',
      password: 'Admin2025!',
      role: 'super_admin',
      isActive: true,
    });
    await OrganizationMember.create({ user: user._id, organization: org._id, role: 'admin' });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'legacy-root@gestionar.test', password: 'Admin2025!' });

    expect(login.status).toBe(200);
    expect(login.body.requiresOrganizationSelection).toBeUndefined();
    expect(login.body.data.user.role).toBe('super_admin');
  });

  test('super_admin crea organizacion con admin accesible por login', async () => {
    await User.create({
      name: 'SaaS Root',
      email: 'root@gestionar.test',
      password: 'Admin2025!',
      role: 'super_admin',
      isActive: true,
    });

    const rootLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'root@gestionar.test', password: 'Admin2025!' });

    const created = await request(app)
      .post('/api/organizations')
      .set('Authorization', `Bearer ${rootLogin.body.token}`)
      .send({
        name: 'El Eden 1',
        businessType: 'consorcio',
        adminEmail: 'felixpiserchia@dontelmo.com',
      });

    expect(created.status).toBe(201);
    expect(created.body.data.admin.email).toBe('felixpiserchia@dontelmo.com');
    expect(created.body.data.adminUserCreated).toBe(true);

    const admin = await User.findOne({ email: 'felixpiserchia@dontelmo.com' }).select('+password');
    expect(admin).toBeTruthy();
    expect(admin.role).toBe('admin');
    expect(admin.mustChangePassword).toBe(true);

    const membership = await OrganizationMember.findOne({
      user: admin._id,
      organization: created.body.data.organization._id,
      role: 'admin',
    });
    expect(membership).toBeTruthy();
    expect(membership.adminRole).toBe('owner_admin');

    expect(emailService.sendAdminWelcome).toHaveBeenCalledTimes(1);
    const tempPassword = emailService.sendAdminWelcome.mock.calls[0][1];

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'felixpiserchia@dontelmo.com', password: tempPassword });

    expect(adminLogin.status).toBe(200);
    expect(adminLogin.body.token).toBeTruthy();
    expect(adminLogin.body.mustChangePassword).toBe(true);
    expect(adminLogin.body.data.user.role).toBe('admin');
  });

  test('super_admin vincula admin al actualizar adminEmail de una organizacion existente', async () => {
    const org = await Organization.create({ name: 'El Eden 1', slug: 'el-eden-1', businessType: 'consorcio' });
    await User.create({
      name: 'SaaS Root',
      email: 'root@gestionar.test',
      password: 'Admin2025!',
      role: 'super_admin',
      isActive: true,
    });

    const rootLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'root@gestionar.test', password: 'Admin2025!' });

    const updated = await request(app)
      .patch(`/api/organizations/${org._id}`)
      .set('Authorization', `Bearer ${rootLogin.body.token}`)
      .send({ adminEmail: 'felixpiserchia@dontelmo.com' });

    expect(updated.status).toBe(200);
    expect(updated.body.data.admin.email).toBe('felixpiserchia@dontelmo.com');

    const admin = await User.findOne({ email: 'felixpiserchia@dontelmo.com' });
    const membership = await OrganizationMember.findOne({ user: admin._id, organization: org._id, role: 'admin' });

    expect(admin).toBeTruthy();
    expect(membership).toBeTruthy();
    expect(membership.adminRole).toBe('owner_admin');
    expect(emailService.sendAdminWelcome).toHaveBeenCalledTimes(1);
  });
});
