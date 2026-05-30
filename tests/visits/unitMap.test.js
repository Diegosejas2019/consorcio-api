const request  = require('supertest');
const app      = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createAdminWithToken, createOwnerWithToken } = require('../helpers/factories');
const Organization       = require('../../src/models/Organization');
const OrganizationMember = require('../../src/models/OrganizationMember');
const OrganizationFeature = require('../../src/models/OrganizationFeature');
const Unit  = require('../../src/models/Unit');
const Visit = require('../../src/models/Visit');
const User  = require('../../src/models/User');
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

describe('GET /api/visits/unit-map', () => {
  test('guardia obtiene unidades solo de su organización (multi-tenant)', async () => {
    const { token: guardToken, orgId: orgA } = await createAdminWithToken();
    await enableVisits(orgA);

    const orgB = (await Organization.create({ name: 'Org B', slug: `org-b-${Date.now()}`, businessType: 'consorcio' }))._id;
    await enableVisits(orgB);

    await Unit.create([
      { organization: orgA, name: 'Unidad A1', active: true },
      { organization: orgA, name: 'Unidad A2', active: true },
      { organization: orgB, name: 'Unidad B1', active: true },
    ]);

    const res = await request(app)
      .get('/api/visits/unit-map')
      .set('Authorization', `Bearer ${guardToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const labels = res.body.data.units.map(u => u.unitLabel);
    expect(labels).toContain('Unidad A1');
    expect(labels).toContain('Unidad A2');
    expect(labels).not.toContain('Unidad B1');
  });

  test('owner no puede acceder (falta permiso visits.read)', async () => {
    const { token: ownerToken, orgId } = await createOwnerWithToken();
    await enableVisits(orgId);

    const res = await request(app)
      .get('/api/visits/unit-map')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(403);
  });

  test('prioridad de estado: inside > pending cuando ambos están presentes', async () => {
    const { token, orgId } = await createAdminWithToken();
    await enableVisits(orgId);

    const owner = await User.create({
      name: 'Propietario', email: `owner-${Date.now()}@test.com`,
      password: 'pass123', role: 'owner', organization: orgId, isActive: true,
    });
    await Unit.create({ organization: orgId, name: 'Unidad X', owner: owner._id, active: true });

    const today = new Date();
    today.setHours(12, 0, 0, 0);

    await Visit.create([
      { organization: orgId, owner: owner._id, name: 'Visitante A', type: 'visit', status: 'inside',  expectedDate: today },
      { organization: orgId, owner: owner._id, name: 'Visitante B', type: 'visit', status: 'pending', expectedDate: today },
    ]);

    const res = await request(app)
      .get('/api/visits/unit-map')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const unit = res.body.data.units.find(u => u.unitLabel === 'Unidad X');
    expect(unit.status).toBe('inside');
    expect(unit.visitCounts.inside).toBe(1);
    expect(unit.visitCounts.pending).toBe(1);
  });

  test('unidad sin visitas devuelve status none y visits vacío', async () => {
    const { token, orgId } = await createAdminWithToken();
    await enableVisits(orgId);

    await Unit.create({ organization: orgId, name: 'Unidad Vacía', active: true });

    const res = await request(app)
      .get('/api/visits/unit-map')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const unit = res.body.data.units.find(u => u.unitLabel === 'Unidad Vacía');
    expect(unit.status).toBe('none');
    expect(unit.visits).toHaveLength(0);
  });

  test('respuesta no incluye campos financieros del propietario', async () => {
    const { token, orgId } = await createAdminWithToken();
    await enableVisits(orgId);

    const owner = await User.create({
      name: 'Owner Con Deuda', email: `owner-deuda-${Date.now()}@test.com`,
      password: 'pass123', role: 'owner', organization: orgId, isActive: true,
    });
    await Unit.create({
      organization: orgId, name: 'Unidad Deudora',
      owner: owner._id, active: true, balance: -5000, isDebtor: true,
    });

    const today = new Date();
    today.setHours(12, 0, 0, 0);
    await Visit.create({
      organization: orgId, owner: owner._id,
      name: 'Visitante', type: 'visit', status: 'approved', expectedDate: today,
    });

    const res = await request(app)
      .get('/api/visits/unit-map')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const unit = res.body.data.units.find(u => u.unitLabel === 'Unidad Deudora');
    expect(unit).toBeDefined();
    expect(unit.balance).toBeUndefined();
    expect(unit.isDebtor).toBeUndefined();
    expect(unit.coefficient).toBeUndefined();
    expect(unit.visits[0].email).toBeUndefined();
    expect(unit.visits[0].phone).toBeUndefined();
  });

  test('feature visits deshabilitada devuelve 403', async () => {
    const { token, orgId } = await createAdminWithToken();
    // No habilitamos visits (DEFAULT_DISABLED_FEATURES incluye 'visits')

    await Unit.create({ organization: orgId, name: 'Unidad Test', active: true });

    const res = await request(app)
      .get('/api/visits/unit-map')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('security_guard puede acceder con permission visits.read', async () => {
    const { orgId } = await createAdminWithToken();
    await enableVisits(orgId);
    const { token: guardToken } = await createSecurityGuard(orgId);

    await Unit.create({ organization: orgId, name: 'Unidad Guard', active: true });

    const res = await request(app)
      .get('/api/visits/unit-map')
      .set('Authorization', `Bearer ${guardToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.units.some(u => u.unitLabel === 'Unidad Guard')).toBe(true);
  });
});
