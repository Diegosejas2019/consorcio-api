const request = require('supertest');
const app = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createAdminWithToken } = require('../helpers/factories');
const User = require('../../src/models/User');
const Unit = require('../../src/models/Unit');
const OrganizationMember = require('../../src/models/OrganizationMember');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function createActiveOwner(orgId, unit = 'Lote 12') {
  const user = await User.create({
    name: 'Owner Existente',
    email: `owner-existente-${Date.now()}@test.com`,
    password: 'password123',
    role: 'owner',
    organization: orgId,
    unit,
    isActive: true,
  });
  await OrganizationMember.create({ user: user._id, organization: orgId, role: 'owner', isActive: true });
  return user;
}

describe('POST /api/owners unit validation', () => {
  test('rechaza alta si la unidad legacy ya pertenece a otro propietario activo', async () => {
    const { token, orgId } = await createAdminWithToken();
    await createActiveOwner(orgId, 'Lote 12');

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Nuevo Propietario',
        email: 'nuevo@test.com',
        password: 'password123',
        unit: ' lote 12 ',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Lote 12');
    expect(res.body.message).toContain('ya est');
  });

  test('rechaza alta si existe una Unit activa con el mismo nombre asignada a otro owner', async () => {
    const { token, orgId } = await createAdminWithToken();
    const existingOwner = await createActiveOwner(orgId, 'Casa Norte');
    await Unit.create({ organization: orgId, owner: existingOwner._id, name: 'Casa Norte', active: true });

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Otro Propietario',
        email: 'otro@test.com',
        password: 'password123',
        unit: 'casa norte',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Casa Norte');
  });

  test('permite alta si la unidad no esta asociada a ningun propietario activo', async () => {
    const { token } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Propietario Libre',
        email: 'libre@test.com',
        password: 'password123',
        unit: 'Lote Libre',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.owner.unit).toBe('Lote Libre');
  });

  test('rechaza vincular usuario existente si conserva una unidad usada por otro owner', async () => {
    const { token, orgId } = await createAdminWithToken();
    await createActiveOwner(orgId, 'Lote 20');
    await User.create({
      name: 'Usuario Global',
      email: 'global@test.com',
      password: 'password123',
      role: 'owner',
      organization: null,
      unit: 'Lote 20',
      isActive: true,
    });

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Usuario Global',
        email: 'global@test.com',
        phone: '123',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Lote 20');
  });

  test('rechaza reactivar usuario inactivo si conserva una unidad usada por otro owner', async () => {
    const { token, orgId } = await createAdminWithToken();
    await createActiveOwner(orgId, 'Lote 30');
    await User.create({
      name: 'Usuario Inactivo',
      email: 'inactivo@test.com',
      password: 'password123',
      role: 'owner',
      organization: orgId,
      unit: 'Lote 30',
      isActive: false,
    });

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Usuario Inactivo',
        email: 'inactivo@test.com',
        password: 'password123',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Lote 30');
  });
});
