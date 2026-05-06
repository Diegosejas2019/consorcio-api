const request = require('supertest');
const app = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createAdminWithToken } = require('../helpers/factories');
const User = require('../../src/models/User');
const Unit = require('../../src/models/Unit');
const OrganizationMember = require('../../src/models/OrganizationMember');
const XLSX = require('xlsx');

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

  test('permite alta con mas de un telefono y mantiene phone como principal', async () => {
    const { token } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Owner Con Telefonos',
        email: 'telefonos@test.com',
        password: 'password123',
        phones: [' 1122334455 ', '1199887766'],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.owner.phone).toBe('1122334455');
    expect(res.body.data.owner.phones).toEqual(['1122334455', '1199887766']);

    const owner = await User.findOne({ email: 'telefonos@test.com' }).lean();
    expect(owner.phone).toBe('1122334455');
    expect(owner.phones).toEqual(['1122334455', '1199887766']);
  });

  test('si recibe phone legacy lo expone tambien como phones', async () => {
    const { token } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Owner Legacy Phone',
        email: 'legacy-phone@test.com',
        password: 'password123',
        phone: '1122334455',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.owner.phone).toBe('1122334455');
    expect(res.body.data.owner.phones).toEqual(['1122334455']);
  });

  test('permite alta con varias unidades disponibles y las marca ocupadas', async () => {
    const { token, orgId } = await createAdminWithToken();
    const units = await Unit.create([
      { organization: orgId, name: 'Lote 1', status: 'available', active: true },
      { organization: orgId, name: 'Lote 2', status: 'available', active: true },
    ]);

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Owner Dos Lotes',
        email: 'dos-lotes@test.com',
        password: 'password123',
        unitIds: units.map(u => u._id),
      });

    expect(res.status).toBe(201);
    expect(res.body.data.owner.units).toHaveLength(2);

    const owner = await User.findOne({ email: 'dos-lotes@test.com' });
    expect(owner.unitId.toString()).toBe(units[0]._id.toString());

    const assigned = await Unit.find({ organization: orgId, owner: owner._id }).sort({ name: 1 }).lean();
    expect(assigned.map(u => ({ name: u.name, status: u.status }))).toEqual([
      { name: 'Lote 1', status: 'occupied' },
      { name: 'Lote 2', status: 'occupied' },
    ]);
  });

  test('rechaza alta con unitIds si alguna unidad ya esta ocupada', async () => {
    const { token, orgId } = await createAdminWithToken();
    const existingOwner = await createActiveOwner(orgId, 'Lote 8');
    const [available, occupied] = await Unit.create([
      { organization: orgId, name: 'Lote 7', status: 'available', active: true },
      { organization: orgId, owner: existingOwner._id, name: 'Lote 8', status: 'occupied', active: true },
    ]);

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Owner Con Conflicto',
        email: 'conflicto@test.com',
        password: 'password123',
        unitIds: [available._id, occupied._id],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Lote 8');
    expect(res.body.message).toContain('ocupada');

    const stillAvailable = await Unit.findById(available._id);
    expect(stillAvailable.owner).toBeNull();
    expect(stillAvailable.status).toBe('available');

    const owner = await User.findOne({ email: 'conflicto@test.com' });
    expect(owner).toBeNull();
  });

  test('actualiza la seleccion multiple liberando unidades removidas', async () => {
    const { token, orgId } = await createAdminWithToken();
    const owner = await createActiveOwner(orgId, null);
    const units = await Unit.create([
      { organization: orgId, owner: owner._id, name: 'Lote 1', status: 'occupied', active: true },
      { organization: orgId, owner: owner._id, name: 'Lote 2', status: 'occupied', active: true },
      { organization: orgId, name: 'Lote 3', status: 'available', active: true },
    ]);
    await User.findByIdAndUpdate(owner._id, { unitId: units[0]._id });

    const res = await request(app)
      .patch(`/api/owners/${owner._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ unitIds: [units[1]._id, units[2]._id] });

    expect(res.status).toBe(200);
    expect(res.body.data.owner.units).toHaveLength(2);

    const updatedUnits = await Unit.find({ organization: orgId }).sort({ name: 1 }).lean();
    expect(updatedUnits.map(u => ({
      name: u.name,
      owner: u.owner?.toString() || null,
      status: u.status,
    }))).toEqual([
      { name: 'Lote 1', owner: null, status: 'available' },
      { name: 'Lote 2', owner: owner._id.toString(), status: 'occupied' },
      { name: 'Lote 3', owner: owner._id.toString(), status: 'occupied' },
    ]);

    const updatedOwner = await User.findById(owner._id);
    expect(updatedOwner.unitId.toString()).toBe(units[1]._id.toString());
  });

  test('actualiza los telefonos reemplazando la lista completa', async () => {
    const { token, orgId } = await createAdminWithToken();
    const owner = await createActiveOwner(orgId, null);

    const res = await request(app)
      .patch(`/api/owners/${owner._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ phones: ['1155000000', '1166000000', '1155000000'] });

    expect(res.status).toBe(200);
    expect(res.body.data.owner.phone).toBe('1155000000');
    expect(res.body.data.owner.phones).toEqual(['1155000000', '1166000000']);

    const updatedOwner = await User.findById(owner._id).lean();
    expect(updatedOwner.phone).toBe('1155000000');
    expect(updatedOwner.phones).toEqual(['1155000000', '1166000000']);
  });

  test('normaliza balance positivo a saldo deudor negativo al editar', async () => {
    const { token, orgId } = await createAdminWithToken();
    const owner = await createActiveOwner(orgId, null);

    const res = await request(app)
      .patch(`/api/owners/${owner._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ balance: 12500 });

    expect(res.status).toBe(200);
    expect(res.body.data.owner.balance).toBe(-12500);
    expect(res.body.data.owner.isDebtor).toBe(true);

    const member = await OrganizationMember.findOne({ user: owner._id, organization: orgId }).lean();
    expect(member.balance).toBe(-12500);
    expect(member.isDebtor).toBe(true);
  });

  test('normaliza saldos positivos de carga masiva como deudas negativas', async () => {
    const { token, orgId } = await createAdminWithToken();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
      {
        nombre: 'Owner Saldo Positivo',
        email: 'saldo-positivo@test.com',
        'contraseña': 'password123',
        saldo: 18500,
        moroso: 'si',
      },
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Propietarios');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const res = await request(app)
      .post('/api/owners/bulk')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, {
        filename: 'owners.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(1);

    const owner = await User.findOne({ email: 'saldo-positivo@test.com' }).lean();
    const member = await OrganizationMember.findOne({ user: owner._id, organization: orgId }).lean();
    expect(member.balance).toBe(-18500);
    expect(member.isDebtor).toBe(true);
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
