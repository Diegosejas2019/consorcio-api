const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const OrganizationMember = require('../src/models/OrganizationMember');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

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
});
