jest.mock('../src/services/emailService', () => ({
  sendWelcome: jest.fn().mockResolvedValue(null),
  sendAdminWelcome: jest.fn().mockResolvedValue(null),
}));

const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const Organization = require('../src/models/Organization');
const User = require('../src/models/User');
const Unit = require('../src/models/Unit');
const OrganizationMember = require('../src/models/OrganizationMember');
const { signToken } = require('../src/middleware/auth');
const emailService = require('../src/services/emailService');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  jest.clearAllMocks();
  await dbHelper.clear();
});

async function createOrg(name = 'Context Org') {
  return Organization.create({
    name: `${name} ${Date.now()}`,
    slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
    businessType: 'consorcio',
  });
}

async function addMembership(user, org, role, extra = {}) {
  return OrganizationMember.create({
    user: user._id,
    organization: org._id,
    role,
    isActive: true,
    ...(role === 'admin' ? { adminRole: 'owner_admin' } : {}),
    ...extra,
  });
}

function scopedToken(user, org, membership) {
  return signToken(user._id, {
    organizationId: org._id,
    role: membership.role,
    membershipId: membership._id,
  });
}

describe('contexto activo admin/propietario', () => {
  test('login devuelve accesos admin y owner para el mismo usuario en la misma organizacion', async () => {
    const org = await createOrg();
    const user = await User.create({
      name: 'Usuario Doble',
      email: 'doble@test.com',
      password: 'password123',
      role: 'owner',
      organization: org._id,
      isActive: true,
    });
    await addMembership(user, org, 'admin');
    await addMembership(user, org, 'owner');

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'doble@test.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.requiresOrganizationSelection).toBe(true);
    expect(res.body.organizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ organizationId: org._id.toString(), accessType: 'admin' }),
      expect.objectContaining({ organizationId: org._id.toString(), accessType: 'owner', ownerId: user._id.toString() }),
    ]));
  });

  test('seleccionar admin habilita endpoints admin y bloquea owner-only', async () => {
    const org = await createOrg();
    const user = await User.create({
      name: 'Admin Owner',
      email: 'admin-owner@test.com',
      password: 'password123',
      role: 'owner',
      organization: org._id,
      isActive: true,
    });
    const adminMembership = await addMembership(user, org, 'admin');
    await addMembership(user, org, 'owner');
    const token = scopedToken(user, org, adminMembership);

    const owners = await request(app)
      .get('/api/owners')
      .set('Authorization', `Bearer ${token}`);
    expect(owners.status).toBe(200);

    const claim = await request(app)
      .post('/api/claims')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'other', title: 'No owner', body: 'No corresponde' });
    expect(claim.status).toBe(403);
  });

  test('seleccionar owner habilita owner-only y bloquea permisos administrativos', async () => {
    const org = await createOrg();
    const user = await User.create({
      name: 'Owner Admin',
      email: 'owner-admin@test.com',
      password: 'password123',
      role: 'admin',
      organization: org._id,
      isActive: true,
    });
    await addMembership(user, org, 'admin');
    const ownerMembership = await addMembership(user, org, 'owner');
    const token = scopedToken(user, org, ownerMembership);

    const claim = await request(app)
      .post('/api/claims')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'other', title: 'Reclamo propio', body: 'Detalle' });
    expect(claim.status).toBe(201);
    expect(claim.body.data.claim.owner._id).toBe(user._id.toString());

    const owners = await request(app)
      .get('/api/owners')
      .set('Authorization', `Bearer ${token}`);
    expect(owners.status).toBe(403);
  });

  test('invitar admin a email owner reutiliza User y no cambia password', async () => {
    const org = await createOrg();
    const inviter = await User.create({
      name: 'Admin',
      email: 'admin@test.com',
      password: 'password123',
      role: 'admin',
      organization: org._id,
      isActive: true,
    });
    const inviterMembership = await addMembership(inviter, org, 'admin');
    const owner = await User.create({
      name: 'Owner Existente',
      email: 'owner-existente@test.com',
      password: 'password123',
      role: 'owner',
      organization: org._id,
      isActive: true,
    });
    await addMembership(owner, org, 'owner');
    const before = await User.findById(owner._id).select('+password');

    const res = await request(app)
      .post('/api/admin/users/invite')
      .set('Authorization', `Bearer ${scopedToken(inviter, org, inviterMembership)}`)
      .send({ name: 'Owner Existente', email: 'owner-existente@test.com', role: 'billing_manager' });

    expect(res.status).toBe(201);
    const after = await User.findById(owner._id).select('+password');
    expect(after.password).toBe(before.password);
    expect(emailService.sendAdminWelcome).not.toHaveBeenCalled();
    const membership = await OrganizationMember.findOne({ user: owner._id, organization: org._id, role: 'admin' });
    expect(membership.adminRole).toBe('billing_manager');
  });

  test('crear propietario con email admin reutiliza User y filtra datos propios por ownerId', async () => {
    const org = await createOrg();
    const admin = await User.create({
      name: 'Admin Existente',
      email: 'admin-existente@test.com',
      password: 'password123',
      role: 'admin',
      organization: org._id,
      isActive: true,
    });
    const adminMembership = await addMembership(admin, org, 'admin');
    const before = await User.findById(admin._id).select('+password');

    const createOwner = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${scopedToken(admin, org, adminMembership)}`)
      .send({ name: 'Admin Existente', email: 'admin-existente@test.com', unit: 'A1' });

    expect(createOwner.status).toBe(201);
    const after = await User.findById(admin._id).select('+password');
    expect(after.password).toBe(before.password);
    expect(emailService.sendWelcome).not.toHaveBeenCalled();
    const ownerMembership = await OrganizationMember.findOne({ user: admin._id, organization: org._id, role: 'owner' });
    expect(ownerMembership).toBeTruthy();

    const other = await User.create({
      name: 'Otro Owner',
      email: 'otro-owner@test.com',
      password: 'password123',
      role: 'owner',
      organization: org._id,
      isActive: true,
    });
    await addMembership(other, org, 'owner');
    await Unit.create([
      { organization: org._id, owner: admin._id, name: 'A1', active: true },
      { organization: org._id, owner: other._id, name: 'B1', active: true },
    ]);

    const units = await request(app)
      .get('/api/units')
      .set('Authorization', `Bearer ${scopedToken(admin, org, ownerMembership)}`);

    expect(units.status).toBe(200);
    expect(units.body.data.units.map(unit => unit.name)).toEqual(['A1']);
  });
});
