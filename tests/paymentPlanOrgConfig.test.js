const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { signToken } = require('../src/middleware/auth');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const OrganizationMember = require('../src/models/OrganizationMember');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function createOrg(fields = {}) {
  return Organization.create({ name: 'TestOrg', slug: `test-${Date.now()}`, businessType: 'consorcio', ...fields });
}

async function createUser(role, orgId) {
  const user = await User.create({
    name: `${role} Test`,
    email: `${role}-${Date.now()}@test.com`,
    password: 'User2025!',
    role,
    organization: orgId,
    isActive: true,
  });
  if (orgId) {
    await OrganizationMember.create({ user: user._id, organization: orgId, role, isActive: true });
  }
  return { user, token: signToken(user._id) };
}

describe('paymentPlan org config — backend guard', () => {
  test('5.1 owner solicita plan con allowOwnerRequests:true → 201 (o error de negocio, no 403)', async () => {
    const org = await createOrg({ paymentPlansAllowOwnerRequests: true });
    const { token } = await createUser('owner', org._id);

    const res = await request(app)
      .post('/api/payment-plans/request')
      .set('Authorization', `Bearer ${token}`)
      .send({ includedPeriods: [] });

    // Not a 403 — guard passes. Business logic may return 400 (no periods), that's ok.
    expect(res.status).not.toBe(403);
  });

  test('5.2 owner solicita plan con allowOwnerRequests:false → 403 OWNER_REQUESTS_DISABLED', async () => {
    const org = await createOrg({ paymentPlansAllowOwnerRequests: false });
    const { token } = await createUser('owner', org._id);

    const res = await request(app)
      .post('/api/payment-plans/request')
      .set('Authorization', `Bearer ${token}`)
      .send({ includedPeriods: [{ month: '2025-01' }] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OWNER_REQUESTS_DISABLED');
    expect(res.body.success).toBe(false);
  });

  test('5.3 GET /payment-plans/my no se afecta cuando allowOwnerRequests:false → 200', async () => {
    const org = await createOrg({ paymentPlansAllowOwnerRequests: false });
    const { token } = await createUser('owner', org._id);

    const res = await request(app)
      .get('/api/payment-plans/my')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.plans).toBeDefined();
  });

  test('5.4 admin crea plan manual cuando allowOwnerRequests:false → no bloquea', async () => {
    const org = await createOrg({ paymentPlansAllowOwnerRequests: false });
    const { token } = await createUser('admin', org._id);

    // Will likely fail validation (no owner, no debt) but NOT with 403
    const res = await request(app)
      .post('/api/payment-plans/admin')
      .set('Authorization', `Bearer ${token}`)
      .send({ ownerId: '507f1f77bcf86cd799439011', includedPeriods: [], installmentsCount: 3, startDate: '2025-01-01' });

    expect(res.status).not.toBe(403);
  });

  test('5.5 multi-tenant: org A deshabilitada, org B habilitada — isolación', async () => {
    const orgA = await createOrg({ slug: `a-${Date.now()}`, paymentPlansAllowOwnerRequests: false });
    const orgB = await createOrg({ slug: `b-${Date.now()}`, paymentPlansAllowOwnerRequests: true });
    const ownerA = await createUser('owner', orgA._id);
    const ownerB = await createUser('owner', orgB._id);

    const resA = await request(app)
      .post('/api/payment-plans/request')
      .set('Authorization', `Bearer ${ownerA.token}`)
      .send({ includedPeriods: [{ month: '2025-01' }] });

    const resB = await request(app)
      .post('/api/payment-plans/request')
      .set('Authorization', `Bearer ${ownerB.token}`)
      .send({ includedPeriods: [] });

    expect(resA.status).toBe(403);
    expect(resA.body.code).toBe('OWNER_REQUESTS_DISABLED');
    expect(resB.status).not.toBe(403);
  });
});

describe('paymentPlan org config — features endpoint', () => {
  test('5.6 features incluye paymentPlans:true y allowOwnerRequests:false', async () => {
    const org = await createOrg({ paymentPlansEnabled: true, paymentPlansAllowOwnerRequests: false });
    const { token } = await createUser('admin', org._id);

    const res = await request(app)
      .get(`/api/organizations/${org._id}/features`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.features['paymentPlans']).toBe(true);
    expect(res.body.data.features['paymentPlans.allowOwnerRequests']).toBe(false);
  });

  test('5.7 features incluye paymentPlans:false y allowOwnerRequests:false cuando módulo desactivado', async () => {
    const org = await createOrg({ paymentPlansEnabled: false, paymentPlansAllowOwnerRequests: true });
    const { token } = await createUser('admin', org._id);

    const res = await request(app)
      .get(`/api/organizations/${org._id}/features`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.features['paymentPlans']).toBe(false);
    // cascade: module off → allowOwnerRequests must also be false
    expect(res.body.data.features['paymentPlans.allowOwnerRequests']).toBe(false);
  });
});
