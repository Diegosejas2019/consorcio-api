const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createOwnerWithToken, createAdminWithToken } = require('./helpers/factories');
const Claim = require('../src/models/Claim');
const OrganizationFeature = require('../src/models/OrganizationFeature');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function enableClaimsFeature(orgId) {
  await OrganizationFeature.findOneAndUpdate(
    { organization: orgId, featureKey: 'claims' },
    { organization: orgId, featureKey: 'claims', enabled: true },
    { upsert: true }
  );
}

describe('Claims multi-tenant isolation', () => {
  test('owner crea reclamo en su organizacion', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    await enableClaimsFeature(orgId);

    const res = await request(app)
      .post('/api/claims')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'noise', title: 'Ruido excesivo', body: 'Hay mucho ruido en las noches.' });

    expect(res.status).toBe(201);
    expect(res.body.data.claim.organization).toBe(orgId.toString());
    expect(res.body.data.claim.owner._id).toBe(user._id.toString());
  });

  test('owner solo ve sus reclamos, no los de otra organizacion', async () => {
    const ownerA = await createOwnerWithToken();
    const ownerB = await createOwnerWithToken({ email: `owner-b-${Date.now()}@test.com` });
    await enableClaimsFeature(ownerA.orgId);
    await enableClaimsFeature(ownerB.orgId);

    await Claim.create({
      organization: ownerA.orgId,
      owner: ownerA.user._id,
      category: 'noise',
      title: 'Reclamo org A',
      body: 'Descripcion del reclamo de org A.',
      status: 'open',
      isActive: true,
    });

    await Claim.create({
      organization: ownerB.orgId,
      owner: ownerB.user._id,
      category: 'security',
      title: 'Reclamo org B',
      body: 'Descripcion del reclamo de org B.',
      status: 'open',
      isActive: true,
    });

    const res = await request(app)
      .get('/api/claims')
      .set('Authorization', `Bearer ${ownerA.token}`);

    expect(res.status).toBe(200);
    const titles = (res.body.data?.claims || res.body.data || []).map((c) => c.title);
    expect(titles).toContain('Reclamo org A');
    expect(titles).not.toContain('Reclamo org B');
  });

  test('admin ve reclamos de su organizacion pero no de otras', async () => {
    const ownerA = await createOwnerWithToken();
    const { token: adminToken } = await createAdminWithToken(ownerA.orgId);
    const ownerB = await createOwnerWithToken({ email: `owner-b-${Date.now()}@test.com` });
    await enableClaimsFeature(ownerA.orgId);
    await enableClaimsFeature(ownerB.orgId);

    await Claim.create({
      organization: ownerA.orgId,
      owner: ownerA.user._id,
      category: 'noise',
      title: 'Reclamo de org A',
      body: 'Descripcion org A.',
      status: 'open',
      isActive: true,
    });

    await Claim.create({
      organization: ownerB.orgId,
      owner: ownerB.user._id,
      category: 'security',
      title: 'Reclamo de org B',
      body: 'Descripcion org B.',
      status: 'open',
      isActive: true,
    });

    const res = await request(app)
      .get('/api/claims')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const titles = (res.body.data?.claims || res.body.data || []).map((c) => c.title);
    expect(titles).toContain('Reclamo de org A');
    expect(titles).not.toContain('Reclamo de org B');
  });

  test('owner no puede cambiar el estado de un reclamo', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    await enableClaimsFeature(orgId);

    const claim = await Claim.create({
      organization: orgId,
      owner: user._id,
      category: 'noise',
      title: 'Test reclamo',
      body: 'Descripcion para cambio de estado.',
      status: 'open',
      isActive: true,
    });

    const res = await request(app)
      .patch(`/api/claims/${claim._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'resolved' });

    expect(res.status).toBe(403);
  });
});
