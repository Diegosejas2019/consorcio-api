const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { signToken } = require('../src/middleware/auth');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const OrganizationMember = require('../src/models/OrganizationMember');
const Payment = require('../src/models/Payment');
const Claim = require('../src/models/Claim');
const AuditLog = require('../src/models/AuditLog');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function createSuperAdminToken() {
  const user = await User.create({
    name: 'Root',
    email: `root-${Date.now()}@test.com`,
    password: 'Admin2025!',
    role: 'super_admin',
    isActive: true,
  });
  return { user, token: signToken(user._id) };
}

async function createOrgUser(role, org, emailPrefix) {
  const user = await User.create({
    name: `${role} User`,
    email: `${emailPrefix}-${Date.now()}@test.com`,
    password: 'User2025!',
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
  return { user, membership, token: signToken(user._id, { organizationId: org._id, role, membershipId: membership._id }) };
}

describe('SuperAdmin organization status', () => {
  test('desactiva organizacion, bloquea admin/owner y no borra datos historicos', async () => {
    const { token, user: root } = await createSuperAdminToken();
    const org = await Organization.create({ name: 'Org Demo', slug: 'org-demo', businessType: 'consorcio' });
    const admin = await createOrgUser('admin', org, 'admin');
    const owner = await createOrgUser('owner', org, 'owner');

    await Payment.create({ owner: owner.user._id, organization: org._id, amount: 100, status: 'pending', month: '2026-04' });
    await Claim.create({ owner: owner.user._id, organization: org._id, category: 'other', title: 'Reclamo', body: 'Historico' });

    const res = await request(app)
      .patch(`/api/super-admin/organizations/${org._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false, reason: 'Falta de pago SaaS' });

    expect(res.status).toBe(200);
    expect(res.body.data.organization.isActive).toBe(false);
    expect(res.body.data.organization.deactivationReason).toBe('Falta de pago SaaS');

    const memberships = await OrganizationMember.find({ organization: org._id });
    expect(memberships.every(m => m.isActive === false && m.deactivatedByOrganization === true)).toBe(true);

    expect(await Payment.countDocuments({ organization: org._id })).toBe(1);
    expect(await Claim.countDocuments({ organization: org._id })).toBe(1);

    const audit = await AuditLog.findOne({ organization: org._id, action: 'organization_deactivated' });
    expect(audit.performedBy.toString()).toBe(root._id.toString());
    expect(audit.reason).toBe('Falta de pago SaaS');

    const adminOldToken = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(adminOldToken.status).toBe(403);
    expect(adminOldToken.body.message).toBe('La organizacion se encuentra desactivada.');

    const ownerLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: owner.user.email, password: 'User2025!' });
    expect(ownerLogin.status).toBe(403);
    expect(ownerLogin.body.message).toBe('Tu organizacion se encuentra desactivada. Contacta al soporte de Gestionar.');
  });

  test('usuario multi-org sigue viendo solo la organizacion activa y la inactiva no aparece en selector', async () => {
    const { token } = await createSuperAdminToken();
    const inactiveOrg = await Organization.create({ name: 'Inactiva', slug: 'inactiva', businessType: 'consorcio' });
    const activeOrg = await Organization.create({ name: 'Activa', slug: 'activa', businessType: 'consorcio' });
    const user = await User.create({
      name: 'Multi Admin',
      email: 'multi-admin@test.com',
      password: 'User2025!',
      role: 'admin',
      isActive: true,
    });
    await OrganizationMember.create({ user: user._id, organization: inactiveOrg._id, role: 'admin', isActive: true });
    await OrganizationMember.create({ user: user._id, organization: activeOrg._id, role: 'admin', isActive: true });

    await request(app)
      .patch(`/api/super-admin/organizations/${inactiveOrg._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'multi-admin@test.com', password: 'User2025!' });

    expect(login.status).toBe(200);
    expect(login.body.requiresOrganizationSelection).toBeUndefined();
    expect(login.body.data.membership.organization._id).toBe(activeOrg._id.toString());
  });

  test('reactiva organizacion y memberships desactivadas por organizacion', async () => {
    const { token } = await createSuperAdminToken();
    const org = await Organization.create({ name: 'Org Reactiva', slug: 'org-reactiva', businessType: 'consorcio' });
    const admin = await createOrgUser('admin', org, 'react-admin');

    await request(app)
      .patch(`/api/super-admin/organizations/${org._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    const reactivate = await request(app)
      .patch(`/api/super-admin/organizations/${org._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: true, reason: 'Cuenta regularizada' });

    expect(reactivate.status).toBe(200);
    expect(reactivate.body.data.organization.isActive).toBe(true);

    const membership = await OrganizationMember.findById(admin.membership._id);
    expect(membership.isActive).toBe(true);
    expect(membership.deactivatedByOrganization).toBe(false);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: admin.user.email, password: 'User2025!' });
    expect(login.status).toBe(200);

    const audit = await AuditLog.findOne({ organization: org._id, action: 'organization_reactivated' });
    expect(audit.reason).toBe('Cuenta regularizada');
  });

  test('admin comun no puede desactivar organizacion', async () => {
    const org = await Organization.create({ name: 'Org Admin', slug: 'org-admin', businessType: 'consorcio' });
    const admin = await createOrgUser('admin', org, 'plain-admin');

    const res = await request(app)
      .patch(`/api/super-admin/organizations/${org._id}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ isActive: false });

    expect(res.status).toBe(403);
  });
});
