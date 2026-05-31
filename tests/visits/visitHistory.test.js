const request  = require('supertest');
const app      = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createAdminWithToken, createOwnerWithToken } = require('../helpers/factories');
const Organization        = require('../../src/models/Organization');
const OrganizationMember  = require('../../src/models/OrganizationMember');
const OrganizationFeature = require('../../src/models/OrganizationFeature');
const User      = require('../../src/models/User');
const Visit    = require('../../src/models/Visit');
const VisitLog  = require('../../src/models/VisitLog');
const { signToken } = require('../../src/middleware/auth');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function enableVisits(orgId) {
  await OrganizationFeature.create({ organization: orgId, featureKey: 'visits', enabled: true });
}

async function createSecurityGuard(orgId) {
  const user = await User.create({
    name: 'Guardia Test',
    email: `guard-${Date.now()}@test.com`,
    password: 'password123',
    role: 'admin',
    organization: orgId,
    isActive: true,
  });
  const membership = await OrganizationMember.create({
    user: user._id,
    organization: orgId,
    role: 'admin',
    adminRole: 'security_guard',
    isActive: true,
  });
  const token = signToken(user._id, {
    organizationId: orgId,
    role: 'admin',
    membershipId: membership._id,
    accessType: 'admin',
    adminRole: 'security_guard',
  });
  return { user, membership, token };
}

async function createLog(orgId, performedById, daysAgo = 0) {
  const ts = new Date();
  ts.setDate(ts.getDate() - daysAgo);
  // Visit stub requerido por el modelo VisitLog
  const visit = await Visit.create({
    organization: orgId,
    owner: performedById,
    name: `Visitante-${daysAgo}`,
    type: 'visit',
    status: 'exited',
    expectedDate: ts,
  });
  return VisitLog.create({
    organization: orgId,
    visit: visit._id,
    action: 'check_in',
    visitorName: `Visitor-${daysAgo}`,
    performedBy: performedById,
    performedByName: 'Guardia',
    performedByRole: 'security_guard',
    timestamp: ts,
  });
}

describe('GET /api/visits/history — security_guard límite 7 días', () => {

  test('3.1 security_guard + preset=today → 200', async () => {
    const { orgId, user: admin } = await createAdminWithToken();
    await enableVisits(orgId);
    const { token, user: guard } = await createSecurityGuard(orgId);
    await createLog(orgId, guard._id, 0);

    const res = await request(app)
      .get('/api/visits/history?preset=today')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.logs)).toBe(true);
  });

  test('3.2 security_guard + preset=yesterday → 200', async () => {
    const { orgId } = await createAdminWithToken();
    await enableVisits(orgId);
    const { token, user: guard } = await createSecurityGuard(orgId);
    await createLog(orgId, guard._id, 1);

    const res = await request(app)
      .get('/api/visits/history?preset=yesterday')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('3.3 security_guard + preset=last7days → 200', async () => {
    const { orgId } = await createAdminWithToken();
    await enableVisits(orgId);
    const { token, user: guard } = await createSecurityGuard(orgId);
    await createLog(orgId, guard._id, 3);

    const res = await request(app)
      .get('/api/visits/history?preset=last7days')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('3.4 security_guard + rango de 30 días → 400', async () => {
    const { orgId } = await createAdminWithToken();
    await enableVisits(orgId);
    const { token } = await createSecurityGuard(orgId);

    const to   = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const dateFrom = from.toISOString().slice(0, 10);
    const dateTo   = to.toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/visits/history?dateFrom=${dateFrom}&dateTo=${dateTo}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/7 días/);
  });

  test('3.5 admin completo + rango de 30 días → 200', async () => {
    const { token, orgId } = await createAdminWithToken();
    await enableVisits(orgId);

    const to   = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const dateFrom = from.toISOString().slice(0, 10);
    const dateTo   = to.toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/visits/history?dateFrom=${dateFrom}&dateTo=${dateTo}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('3.6 preset=monthly (inválido) → 400', async () => {
    const { orgId } = await createAdminWithToken();
    await enableVisits(orgId);
    const { token } = await createSecurityGuard(orgId);

    const res = await request(app)
      .get('/api/visits/history?preset=monthly')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Preset no válido/);
  });

  test('3.7 owner llama /history → 403', async () => {
    const { token, orgId } = await createOwnerWithToken();
    await enableVisits(orgId);

    const res = await request(app)
      .get('/api/visits/history')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('3.8 respuesta no contiene campos financieros', async () => {
    const { orgId } = await createAdminWithToken();
    await enableVisits(orgId);
    const { token, user: guard } = await createSecurityGuard(orgId);
    await createLog(orgId, guard._id, 0);

    const res = await request(app)
      .get('/api/visits/history?preset=today')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const log = res.body.data.logs[0] ?? {};
    expect(log).toBeDefined();
    // VisitLog no tiene campos financieros por diseño del modelo
    expect(log.amount).toBeUndefined();
    expect(log.balance).toBeUndefined();
    expect(log.debtAmount).toBeUndefined();
    expect(log.payments).toBeUndefined();
  });

  test('security_guard solo ve logs de su organización (multi-tenant)', async () => {
    const { orgId: orgA, user: adminA } = await createAdminWithToken();
    const { orgId: orgB, user: adminB } = await createAdminWithToken();
    await enableVisits(orgA);
    await enableVisits(orgB);

    const { token, user: guard } = await createSecurityGuard(orgA);
    await createLog(orgA, guard._id, 0);
    const logB = await createLog(orgB, adminB._id, 0);

    const res = await request(app)
      .get('/api/visits/history?preset=today')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.logs.map(l => l._id.toString());
    expect(ids).not.toContain(logB._id.toString());
  });

  test('feature visits deshabilitada → 403', async () => {
    const { orgId } = await createAdminWithToken();
    const { token } = await createSecurityGuard(orgId);

    const res = await request(app)
      .get('/api/visits/history?preset=today')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

});
