const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createAdminWithToken } = require('./helpers/factories');
const Organization = require('../src/models/Organization');
const OrganizationMember = require('../src/models/OrganizationMember');
const User = require('../src/models/User');
const Unit = require('../src/models/Unit');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

describe('Units admin flows', () => {
  test('crea unidades por rango sin propietario', async () => {
    const { token, orgId } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/units/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ count: 3, start: 1, prefix: 'Lote' });

    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(3);

    const units = await Unit.find({ organization: orgId }).sort({ name: 1 }).lean();
    expect(units.map(u => u.name)).toEqual(['Lote 1', 'Lote 2', 'Lote 3']);
    expect(units.every(u => u.owner === null && u.status === 'available' && u.active)).toBe(true);
  });

  test('omite nombres existentes al crear unidades por rango', async () => {
    const { token, orgId } = await createAdminWithToken();
    await Unit.create({ organization: orgId, name: 'Lote 2', status: 'available', active: true });

    const res = await request(app)
      .post('/api/units/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ count: 3, start: 1, prefix: 'Lote' });

    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.skipped).toBe(1);
    expect(res.body.data.skippedNames).toEqual(['Lote 2']);
  });

  test('omite números existentes al crear unidades por rango aunque cambie el prefijo', async () => {
    const { token, orgId } = await createAdminWithToken();
    await Unit.create([
      { organization: orgId, name: 'Unidad 1', status: 'available', active: true },
      { organization: orgId, name: 'UF-02', status: 'available', active: true },
    ]);

    const res = await request(app)
      .post('/api/units/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ count: 4, start: 1, prefix: 'Lote' });

    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.skipped).toBe(2);
    expect(res.body.data.skippedNames).toEqual(['Lote 1', 'Lote 2']);

    const units = await Unit.find({ organization: orgId, active: true }).sort({ name: 1 }).lean();
    expect(units.map(u => u.name)).toEqual(['Lote 3', 'Lote 4', 'UF-02', 'Unidad 1']);
  });

  test('rechaza crear una unidad individual si el número ya existe con otro prefijo', async () => {
    const { token, orgId } = await createAdminWithToken();
    await Unit.create({ organization: orgId, name: 'Lote 7', status: 'available', active: true });

    const res = await request(app)
      .post('/api/units')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Unidad 007' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('ya existe');
  });

  test('permite crear unidad para owner vinculado por membresia multi-org', async () => {
    const { token, orgId } = await createAdminWithToken();
    const otherOrg = await Organization.create({ name: 'Otra Org', slug: 'otra-org', businessType: 'consorcio' });
    const owner = await User.create({
      name: 'Owner Multi Org',
      email: 'multi@test.com',
      password: 'password123',
      role: 'owner',
      organization: otherOrg._id,
      isActive: true,
    });
    await OrganizationMember.create({ user: owner._id, organization: orgId, role: 'owner', isActive: true });

    const res = await request(app)
      .post('/api/units')
      .set('Authorization', `Bearer ${token}`)
      .send({ ownerId: owner._id, name: 'Lote 10' });

    expect(res.status).toBe(201);
    expect(res.body.data.unit.status).toBe('occupied');

    const unit = await Unit.findOne({ organization: orgId, name: 'Lote 10' });
    expect(unit.owner.toString()).toBe(owner._id.toString());
  });

  test('al eliminar owner libera todas sus unidades activas', async () => {
    const { token, orgId } = await createAdminWithToken();
    const owner = await User.create({
      name: 'Owner con varias unidades',
      email: 'varias@test.com',
      password: 'password123',
      role: 'owner',
      organization: orgId,
      isActive: true,
    });
    await OrganizationMember.create({ user: owner._id, organization: orgId, role: 'owner', isActive: true });
    await Unit.create([
      { organization: orgId, owner: owner._id, name: 'Lote 1', status: 'occupied', active: true },
      { organization: orgId, owner: owner._id, name: 'Lote 2', status: 'occupied', active: true },
    ]);

    const res = await request(app)
      .delete(`/api/owners/${owner._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);

    const units = await Unit.find({ organization: orgId }).sort({ name: 1 }).lean();
    expect(units.map(u => ({ owner: u.owner, status: u.status }))).toEqual([
      { owner: null, status: 'available' },
      { owner: null, status: 'available' },
    ]);
  });
});
