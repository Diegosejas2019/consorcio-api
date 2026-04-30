const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { signToken } = require('../src/middleware/auth');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const OrganizationFeature = require('../src/models/OrganizationFeature');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function createUser(role, orgId = null) {
  const user = await User.create({
    name: `${role} Test`,
    email: `${role}-${Date.now()}@test.com`,
    password: 'User2025!',
    role,
    organization: orgId,
    isActive: true,
  });
  return { user, token: signToken(user._id) };
}

describe('Organization feature modules', () => {
  test('devuelve el catalogo completo con defaults por organizacion', async () => {
    const org = await Organization.create({ name: 'Modulos', slug: 'modulos', businessType: 'consorcio' });
    const { token } = await createUser('admin', org._id);

    const res = await request(app)
      .get(`/api/organizations/${org._id}/features`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.features).toEqual({
      visits: false,
      reservations: false,
      votes: true,
      claims: true,
      notices: true,
      expenses: true,
      providers: true,
    });
  });

  test('solo super_admin puede actualizar modulos, incluyendo reclamos y comunicados', async () => {
    const org = await Organization.create({ name: 'Flags', slug: 'flags', businessType: 'consorcio' });
    const admin = await createUser('admin', org._id);
    const root = await createUser('super_admin');

    const forbidden = await request(app)
      .put(`/api/organizations/${org._id}/features`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ visits: true });

    expect(forbidden.status).toBe(403);

    const updated = await request(app)
      .put(`/api/organizations/${org._id}/features`)
      .set('Authorization', `Bearer ${root.token}`)
      .send({
        visits: true,
        claims: false,
        notices: false,
        unknown: true,
      });

    expect(updated.status).toBe(200);
    expect(updated.body.data.features.visits).toBe(true);
    expect(updated.body.data.features.claims).toBe(false);
    expect(updated.body.data.features.notices).toBe(false);
    expect(updated.body.data.features.unknown).toBeUndefined();

    const storedUnknown = await OrganizationFeature.findOne({ organization: org._id, featureKey: 'unknown' });
    expect(storedUnknown).toBeNull();
  });
});
