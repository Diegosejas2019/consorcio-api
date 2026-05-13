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
const PaymentPlanInstallment = require('../../src/models/PaymentPlanInstallment');
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
    name: data.name || 'Owner Plan',
    email: data.email || `owner-plan-${suffix}@test.com`,
    password: 'password123',
    role: 'owner',
    organization: orgId,
    isActive: true,
  });
  await OrganizationMember.create({
    user: user._id,
    organization: orgId,
    role: 'owner',
    isActive: true,
    startBillingPeriod: data.startBillingPeriod,
  });
  const unit = await Unit.create({
    organization: orgId,
    owner: user._id,
    name: data.unitName || 'A-01',
    balance: data.balance || 0,
    isDebtor: Number(data.balance || 0) < 0,
    active: true,
  });
  return { user, unit };
}

describe('planes de pago y deuda financiada', () => {
  test('solicitar plan bloquea el periodo incluido en available-items', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-03';
    const { user, token, orgId } = await createOwnerWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 1000,
      paymentPeriods: ['2026-01', '2026-02', '2026-03'],
    });
    await OrganizationMember.create({
      user: user._id,
      organization: orgId,
      role: 'owner',
      isActive: true,
      startBillingPeriod: '2026-01',
    });
    await Unit.create({ organization: orgId, owner: user._id, name: 'A-01', active: true });

    const createRes = await request(app)
      .post('/api/payment-plans/request')
      .set('Authorization', `Bearer ${token}`)
      .send({ includedPeriods: [{ month: '2026-01' }] });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.plan.originalDebtAmount).toBe(1000);

    const availableRes = await request(app)
      .get('/api/payments/available-items')
      .set('Authorization', `Bearer ${token}`);

    expect(availableRes.status).toBe(200);
    expect(availableRes.body.data.periods).not.toContain('2026-01');
    expect(availableRes.body.data.periods).toEqual(['2026-02', '2026-03']);
  });

  test('saldo anterior en plan baja deuda exigible y sube plannedDebtAmount', async () => {
    const { token, orgId } = await createAdminWithToken();
    const { user } = await createOwnerInOrg(orgId, { balance: -1500 });

    const planRes = await request(app)
      .post('/api/payment-plans/admin')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ownerId: user._id,
        balanceDebt: 1500,
        installmentsCount: 3,
        startDate: '2026-06-01',
      });

    expect(planRes.status).toBe(201);
    expect(planRes.body.data.plan.balanceDebt).toBe(1500);

    const ownersRes = await request(app)
      .get('/api/payments/admin/owners?limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(ownersRes.status).toBe(200);
    const owner = ownersRes.body.data.owners.find(item => item.id === user._id.toString());
    expect(owner.totalOwed).toBe(0);
    expect(owner.plannedDebtAmount).toBe(1500);
    expect(owner.hasActivePlan).toBe(true);
  });

  test('registrar cuota desde admin crea Payment type installment', async () => {
    const { token, orgId } = await createAdminWithToken();
    const { user } = await createOwnerInOrg(orgId, { balance: -900 });
    const planRes = await request(app)
      .post('/api/payment-plans/admin')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ownerId: user._id,
        balanceDebt: 900,
        installmentsCount: 1,
        startDate: '2026-06-01',
      });

    const installment = await PaymentPlanInstallment.findOne({ paymentPlan: planRes.body.data.plan._id });
    const payRes = await request(app)
      .post(`/api/payment-plans/admin/installments/${installment._id}/register-payment`)
      .set('Authorization', `Bearer ${token}`);

    expect(payRes.status).toBe(200);
    const payment = await Payment.findById(payRes.body.data.payment._id);
    expect(payment.type).toBe('installment');
    expect(payment.installmentId.toString()).toBe(installment._id.toString());
  });
});
