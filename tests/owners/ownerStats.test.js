const request = require('supertest');
const app = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createAdminWithToken } = require('../helpers/factories');
const Organization = require('../../src/models/Organization');
const OrganizationMember = require('../../src/models/OrganizationMember');
const Payment = require('../../src/models/Payment');
const Unit = require('../../src/models/Unit');
const User = require('../../src/models/User');
const { currentYYYYMM } = require('../../src/utils/periods');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function createOwner(orgId, name, unitName) {
  const user = await User.create({
    name,
    email: `${name}-${Date.now()}@test.com`,
    password: 'password123',
    role: 'owner',
    organization: orgId,
    isActive: true,
  });
  const membership = await OrganizationMember.create({
    user: user._id,
    organization: orgId,
    role: 'owner',
    isActive: true,
  });
  const unit = await Unit.create({
    organization: orgId,
    owner: user._id,
    name: unitName,
    balance: 0,
    isDebtor: true,
    active: true,
  });
  return { user, membership, unit };
}

describe('GET /api/owners/stats', () => {
  test('calcula morosos por deuda real y no por flags isDebtor antiguos', async () => {
    const { token, orgId } = await createAdminWithToken();
    const period = currentYYYYMM();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 40000,
      paymentPeriods: [period],
    });

    const ownerOk = await createOwner(orgId, 'owner-al-dia', 'Lote 1');
    await createOwner(orgId, 'owner-moroso-1', 'Lote 2');
    await createOwner(orgId, 'owner-moroso-2', 'Lote 3');

    await Payment.create({
      organization: orgId,
      owner: ownerOk.user._id,
      membership: ownerOk.membership._id,
      month: period,
      amount: 40000,
      status: 'approved',
      type: 'monthly',
      units: [ownerOk.unit._id],
    });

    const res = await request(app)
      .get('/api/owners/stats')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalOwners).toBe(3);
    expect(res.body.data.debtors).toBe(2);
    expect(res.body.data.upToDate).toBe(1);
    expect(res.body.data.complianceRate).toBe(33);
  });
});
