const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { signToken } = require('../src/middleware/auth');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const OrganizationMember = require('../src/models/OrganizationMember');
const PlatformUsageEvent = require('../src/models/PlatformUsageEvent');
const { trackUsageEvent } = require('../src/services/platformUsageService');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => {
  jest.restoreAllMocks();
  return dbHelper.clear();
});

async function createSuperAdminToken() {
  const user = await User.create({
    name: 'Root Analytics',
    email: `root-analytics-${Date.now()}@test.com`,
    password: 'Admin2026!',
    role: 'super_admin',
    isActive: true,
  });
  return { user, token: signToken(user._id) };
}

async function createOrgUser(role, org, emailPrefix) {
  const user = await User.create({
    name: `${role} Analytics`,
    email: `${emailPrefix}-${Date.now()}@test.com`,
    password: 'User2026!',
    role,
    organization: org._id,
    isActive: true,
  });
  const membership = await OrganizationMember.create({
    user: user._id,
    organization: org._id,
    role,
    isActive: true,
  });
  return {
    user,
    membership,
    token: signToken(user._id, { organizationId: org._id, role, membershipId: membership._id }),
  };
}

describe('SuperAdmin analytics de uso', () => {
  test('super_admin accede al overview agregado', async () => {
    const { token, user } = await createSuperAdminToken();
    const org = await Organization.create({ name: 'Org Uso', slug: 'org-uso', businessType: 'consorcio' });

    await PlatformUsageEvent.create({
      organizationId: org._id,
      userId: user._id,
      role: 'super_admin',
      eventType: 'documents.upload',
      module: 'documents',
      metadata: { fileType: 'application/pdf' },
    });

    const res = await request(app)
      .get('/api/super-admin/analytics/overview')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalOrganizations).toBe(1);
    expect(res.body.data.documentsUploadedThisMonth).toBe(1);
    expect(res.body.data.activeUsersThisMonth).toBe(1);
  });

  test('admin comun no puede acceder a analytics globales', async () => {
    const org = await Organization.create({ name: 'Org Admin Analytics', slug: 'org-admin-analytics', businessType: 'consorcio' });
    const admin = await createOrgUser('admin', org, 'analytics-admin');

    const res = await request(app)
      .get('/api/super-admin/analytics/overview')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(res.status).toBe(403);
  });

  test('daily activity devuelve agregados sin eventos crudos', async () => {
    const { token, user } = await createSuperAdminToken();
    const org = await Organization.create({ name: 'Org Daily', slug: 'org-daily', businessType: 'consorcio' });

    await PlatformUsageEvent.create([
      {
        organizationId: org._id,
        userId: user._id,
        role: 'super_admin',
        eventType: 'auth.login',
        module: 'auth',
        createdAt: new Date('2026-05-01T10:00:00.000Z'),
      },
      {
        organizationId: org._id,
        userId: user._id,
        role: 'super_admin',
        eventType: 'payments.created',
        module: 'payments',
        metadata: { amount: 1000, currency: 'ARS' },
        createdAt: new Date('2026-05-01T11:00:00.000Z'),
      },
    ]);

    const res = await request(app)
      .get('/api/super-admin/analytics/daily-activity?from=2026-05-01&to=2026-05-01')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.activity).toHaveLength(1);
    expect(res.body.data.activity[0]).toMatchObject({
      date: '2026-05-01',
      totalEvents: 2,
      activeUsers: 1,
      logins: 1,
      payments: 1,
    });
    expect(res.body.data.activity[0].metadata).toBeUndefined();
    expect(res.body.data.activity[0].eventType).toBeUndefined();
  });

  test('trackUsageEvent no rompe si falla la persistencia', async () => {
    jest.spyOn(PlatformUsageEvent, 'create').mockRejectedValueOnce(new Error('mongo down'));

    await expect(trackUsageEvent({
      userId: null,
      role: 'admin',
      eventType: 'auth.login',
      module: 'auth',
      metadata: { password: 'secreto', accessType: 'admin' },
    })).resolves.toBeNull();
  });
});
