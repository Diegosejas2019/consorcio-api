jest.mock('../../src/config/cloudinary', () => {
  const multer = require('multer');
  const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  return {
    upload: memoryUpload,
    uploadProvider: memoryUpload,
    uploadClaim: memoryUpload,
    uploadNotice: memoryUpload,
    uploadEmployee: memoryUpload,
    uploadOrganizationDocument: memoryUpload,
    deleteCloudinaryAttachments: jest.fn().mockResolvedValue(null),
    cloudinary: { uploader: { destroy: jest.fn().mockResolvedValue({}) } },
  };
});

jest.mock('../../src/services/firebaseService', () => ({
  sendToUser:    jest.fn().mockResolvedValue(null),
  sendMulticast: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/services/emailService', () => ({
  sendPaymentApproved: jest.fn().mockResolvedValue(null),
  sendPaymentRejected: jest.fn().mockResolvedValue(null),
  sendReceiptEmail:    jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/services/receiptService', () => ({
  generateAndStoreReceipt: jest.fn().mockImplementation(async (paymentId) => {
    const Payment = require('../../src/models/Payment');
    return Payment.findById(paymentId);
  }),
}));

const request = require('supertest');
const app = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createAdminWithToken, createOwnerWithToken } = require('../helpers/factories');
const Organization = require('../../src/models/Organization');
const OrganizationMember = require('../../src/models/OrganizationMember');
const Payment = require('../../src/models/Payment');
const Unit = require('../../src/models/Unit');
const User = require('../../src/models/User');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  delete process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE;
  await dbHelper.clear();
});

async function createOwnerInOrg(orgId, data = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await User.create({
    name:         data.name || 'Owner Test',
    email:        data.email || `owner-admin-payments-${suffix}@test.com`,
    password:     'password123',
    role:         'owner',
    organization: orgId,
    unit:         data.unit,
    isActive:     true,
  });

  const membership = await OrganizationMember.create({
    user:               user._id,
    organization:       orgId,
    role:               'owner',
    isActive:           true,
    balance:            data.balance ?? 0,
    isDebtor:           data.isDebtor ?? false,
    startBillingPeriod: data.startBillingPeriod,
  });

  if (data.unitName) {
    await Unit.create({
      organization: orgId,
      owner:        user._id,
      name:         data.unitName,
      coefficient:  data.coefficient ?? 1,
      customFee:    data.customFee ?? null,
      balance:      data.balance ?? 0,
      isDebtor:     (data.balance ?? 0) < 0,
    });
  }

  return { user, membership };
}

describe('GET /api/payments/admin/owners', () => {
  test('admin recibe owners paginados y ordenados con morosos primero', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-03';
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 1000,
      paymentPeriods: ['2026-01', '2026-02', '2026-03'],
    });

    const debtor = await createOwnerInOrg(orgId, {
      name: 'Zeta Deudor',
      unitName: 'A-01',
      balance: -500,
      isDebtor: true,
      startBillingPeriod: '2026-01',
    });
    const upToDate = await createOwnerInOrg(orgId, {
      name: 'Alfa Al Dia',
      unitName: 'B-01',
      startBillingPeriod: '2026-01',
    });

    await Payment.create([
      { organization: orgId, owner: upToDate.user._id, month: '2026-01', amount: 1000, status: 'approved', type: 'monthly' },
      { organization: orgId, owner: upToDate.user._id, month: '2026-02', amount: 1000, status: 'approved', type: 'monthly' },
      { organization: orgId, owner: upToDate.user._id, month: '2026-03', amount: 1000, status: 'approved', type: 'monthly' },
    ]);

    const res = await request(app)
      .get('/api/payments/admin/owners?limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.owners).toHaveLength(2);
    expect(res.body.data.owners[0].id).toBe(debtor.user._id.toString());
    expect(res.body.data.owners[0].isDebtor).toBe(true);
    expect(res.body.data.owners[0].totalOwed).toBe(3500);
    expect(res.body.data.owners[1].id).toBe(upToDate.user._id.toString());
    expect(res.body.pagination.total).toBe(2);
  });

  test('filtra por search, debtor y pending_review', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-02';
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 2000,
      paymentPeriods: ['2026-01', '2026-02'],
    });

    const pendingOwner = await createOwnerInOrg(orgId, {
      name: 'Mora Pendiente',
      email: 'mora-pendiente@test.com',
      unitName: 'Casa Norte',
      startBillingPeriod: '2026-01',
    });
    await createOwnerInOrg(orgId, {
      name: 'Sin Deuda',
      email: 'sin-deuda@test.com',
      unitName: 'Casa Sur',
      startBillingPeriod: '2026-01',
    });
    await Payment.create([
      { organization: orgId, owner: pendingOwner.user._id, month: '2026-01', amount: 2000, status: 'approved', type: 'monthly' },
      {
        organization: orgId,
        owner: pendingOwner.user._id,
        month: '2026-02',
        amount: 2000,
        status: 'pending',
        type: 'monthly',
        receipt: { url: 'https://example.com/comprobante.pdf', filename: 'comprobante.pdf' },
      },
    ]);

    const searchRes = await request(app)
      .get('/api/payments/admin/owners?search=norte')
      .set('Authorization', `Bearer ${token}`);
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.data.owners).toHaveLength(1);
    expect(searchRes.body.data.owners[0].email).toBe('mora-pendiente@test.com');

    const debtorRes = await request(app)
      .get('/api/payments/admin/owners?status=debtor')
      .set('Authorization', `Bearer ${token}`);
    expect(debtorRes.status).toBe(200);
    expect(debtorRes.body.data.owners.every(owner => owner.totalOwed > 0)).toBe(true);

    const pendingRes = await request(app)
      .get('/api/payments/admin/owners?status=pending_review')
      .set('Authorization', `Bearer ${token}`);
    expect(pendingRes.status).toBe(200);
    expect(pendingRes.body.data.owners).toHaveLength(1);
    expect(pendingRes.body.data.owners[0].pendingPayments[0].hasReceipt).toBe(true);
  });

  test('period marca pago aprobado, pendiente o adeudado', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-03';
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 1000,
      paymentPeriods: ['2026-01', '2026-02', '2026-03'],
    });

    const paidOwner = await createOwnerInOrg(orgId, { name: 'Periodo Pago', unitName: 'A-01', startBillingPeriod: '2026-01' });
    const pendingOwner = await createOwnerInOrg(orgId, { name: 'Periodo Pendiente', unitName: 'A-02', startBillingPeriod: '2026-01' });
    const unpaidOwner = await createOwnerInOrg(orgId, { name: 'Periodo Adeudado', unitName: 'A-03', startBillingPeriod: '2026-01' });

    await Payment.create([
      { organization: orgId, owner: paidOwner.user._id, month: '2026-02', amount: 1000, status: 'approved', type: 'monthly' },
      { organization: orgId, owner: pendingOwner.user._id, month: '2026-02', amount: 1000, status: 'pending', type: 'monthly' },
    ]);

    const res = await request(app)
      .get('/api/payments/admin/owners?period=2026-02&sort=name&limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const statusByName = Object.fromEntries(res.body.data.owners.map(owner => [owner.name, owner.selectedPeriodStatus]));
    expect(statusByName[paidOwner.user.name]).toBe('paid');
    expect(statusByName[pendingOwner.user.name]).toBe('pending');
    expect(statusByName[unpaidOwner.user.name]).toBe('unpaid');
  });

  test('owner no puede acceder al endpoint admin', async () => {
    const { token } = await createOwnerWithToken();

    const res = await request(app)
      .get('/api/payments/admin/owners')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('no mezcla owners ni pagos de otras organizaciones', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-01';
    const { token: tokenA, orgId: orgA } = await createAdminWithToken();
    const { orgId: orgB } = await createAdminWithToken();
    await Organization.updateMany(
      { _id: { $in: [orgA, orgB] } },
      { monthlyFee: 1000, paymentPeriods: ['2026-01'] }
    );

    const ownerA = await createOwnerInOrg(orgA, { name: 'Owner Org A', startBillingPeriod: '2026-01' });
    const ownerB = await createOwnerInOrg(orgB, { name: 'Owner Org B', startBillingPeriod: '2026-01' });
    await Payment.create([
      { organization: orgA, owner: ownerA.user._id, month: '2026-01', amount: 1000, status: 'pending', type: 'monthly' },
      { organization: orgB, owner: ownerB.user._id, month: '2026-01', amount: 1000, status: 'pending', type: 'monthly' },
    ]);

    const res = await request(app)
      .get('/api/payments/admin/owners?status=pending_review')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.owners).toHaveLength(1);
    expect(res.body.data.owners[0].name).toBe('Owner Org A');
    expect(res.body.data.owners[0].pendingPayments).toHaveLength(1);
  });

  test('aprobar un pago pendiente sigue funcionando desde el endpoint existente', async () => {
    const { token, orgId } = await createAdminWithToken();
    const { user } = await createOwnerInOrg(orgId, { name: 'Aprobar Pago', unitName: 'A-04', balance: -1000, isDebtor: true });
    const unit = await Unit.findOne({ owner: user._id, organization: orgId });
    const payment = await Payment.create({
      organization:  orgId,
      owner:         user._id,
      amount:        1000,
      status:        'pending',
      type:          'balance',
      paymentMethod: 'manual',
      units:         [unit._id],
    });

    const res = await request(app)
      .patch(`/api/payments/${payment._id}/approve`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.payment.status).toBe('approved');
    const updatedUnit = await Unit.findById(unit._id);
    expect(updatedUnit.balance).toBe(0);
    expect(updatedUnit.isDebtor).toBe(false);
  });
});
