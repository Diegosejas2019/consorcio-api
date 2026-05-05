const mockMPPaymentGet = jest.fn();
const mockPreferenceCreate = jest.fn();

jest.mock('mercadopago', () => ({
  MercadoPagoConfig: jest.fn().mockImplementation(config => config),
  Preference:        jest.fn().mockImplementation(() => ({
    create: mockPreferenceCreate,
  })),
  Payment:           jest.fn().mockImplementation(() => ({
    get: mockMPPaymentGet,
  })),
}));

jest.mock('../../src/services/firebaseService', () => ({
  sendToUser:    jest.fn().mockResolvedValue(null),
  sendMulticast: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/services/emailService', () => ({
  sendPaymentApproved: jest.fn().mockResolvedValue(null),
  sendPaymentRejected: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/services/receiptService', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ systemReceipt: { url: 'https://cdn.example.com/recibo.pdf' } }),
}));

const request = require('supertest');
const app = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const Organization = require('../../src/models/Organization');
const OrganizationMember = require('../../src/models/OrganizationMember');
const Payment = require('../../src/models/Payment');
const Unit = require('../../src/models/Unit');
const User = require('../../src/models/User');
const Expense = require('../../src/models/Expense');
const emailService = require('../../src/services/emailService');
const firebaseService = require('../../src/services/firebaseService');
const receiptService = require('../../src/services/receiptService');
const { signToken } = require('../../src/middleware/auth');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
beforeEach(() => {
  jest.clearAllMocks();
  mockPreferenceCreate.mockResolvedValue({
    id: 'pref-test',
    init_point: 'https://mp.example.com/init',
    sandbox_init_point: 'https://mp.example.com/sandbox',
  });
});
afterEach(async () => {
  await dbHelper.clear();
});

async function waitForPayment(filter, predicate = Boolean) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const payment = await Payment.findOne(filter);
    if (payment && predicate(payment)) return payment;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return Payment.findOne(filter);
}

describe('POST /api/mercadopago/preference', () => {
  test('crea preferencia para pagar saldo anterior sin período', async () => {
    const org = await Organization.create({
      name:          'Org MP Balance',
      slug:          `org-mp-balance-${Date.now()}`,
      businessType:  'consorcio',
      monthlyFee:    10000,
      feePeriodCode: '2026-05',
      mpAccessToken: 'TEST_ACCESS_TOKEN',
    });
    const owner = await User.create({
      name: 'Owner Balance',
      email: `owner-balance-${Date.now()}@test.com`,
      password: 'password123',
      role: 'owner',
      organization: org._id,
      isActive: true,
    });
    const membership = await OrganizationMember.create({
      user: owner._id,
      organization: org._id,
      role: 'owner',
      balance: -25000,
      isDebtor: true,
    });
    const token = signToken(owner._id, { organizationId: org._id, role: 'owner', membershipId: membership._id });

    const res = await request(app)
      .post('/api/mercadopago/preference')
      .set('Authorization', `Bearer ${token}`)
      .send({ balanceAmount: 25000 });

    expect(res.status).toBe(200);
    expect(res.body.data.balanceAmount).toBe(25000);
    expect(res.body.data.totalAmount).toBe(25000);
    const body = mockPreferenceCreate.mock.calls[0][0].body;
    expect(body.items[0]).toEqual(expect.objectContaining({
      title: expect.stringContaining('Saldo anterior'),
      unit_price: 25000,
    }));
    expect(body.external_reference).toContain('|v2||');
  });

  test('crea preferencia para gasto extraordinario sin período mensual', async () => {
    const org = await Organization.create({
      name:          'Org MP Extra',
      slug:          `org-mp-extra-${Date.now()}`,
      businessType:  'consorcio',
      monthlyFee:    10000,
      feePeriodCode: '2026-05',
      mpAccessToken: 'TEST_ACCESS_TOKEN',
    });
    const owner = await User.create({
      name: 'Owner Extra',
      email: `owner-extra-${Date.now()}@test.com`,
      password: 'password123',
      role: 'owner',
      organization: org._id,
      isActive: true,
    });
    const membership = await OrganizationMember.create({
      user: owner._id,
      organization: org._id,
      role: 'owner',
    });
    await Unit.create({
      organization: org._id,
      owner: owner._id,
      name: 'Lote 2',
      status: 'occupied',
      active: true,
    });
    const expense = await Expense.create({
      organization: org._id,
      description: 'Reparación portón',
      category: 'maintenance',
      amount: 8000,
      date: new Date('2026-05-02'),
      expenseType: 'extraordinary',
      isChargeable: true,
      extraordinaryBillingMode: 'fixed_total',
      createdBy: owner._id,
    });
    const token = signToken(owner._id, { organizationId: org._id, role: 'owner', membershipId: membership._id });

    const res = await request(app)
      .post('/api/mercadopago/preference')
      .set('Authorization', `Bearer ${token}`)
      .send({ extraordinaryIds: [expense._id.toString()] });

    expect(res.status).toBe(200);
    expect(res.body.data.periods).toEqual([]);
    expect(res.body.data.extraordinaryIds).toEqual([expense._id.toString()]);
    const body = mockPreferenceCreate.mock.calls[0][0].body;
    expect(body.items[0]).toEqual(expect.objectContaining({
      title: expect.stringContaining('Gasto extraordinario'),
      unit_price: 8000,
    }));
    expect(body.external_reference).toContain(`|v2||${expense._id}|0|`);
  });
});

describe('POST /api/mercadopago/webhook', () => {
  test('operación MP approved crea pago pendiente de aprobación', async () => {
    const org = await Organization.create({
      name:          'Org MP',
      slug:          `org-mp-${Date.now()}`,
      businessType:  'consorcio',
      monthlyFee:    10000,
      mpAccessToken: 'TEST_ACCESS_TOKEN',
    });

    const owner = await User.create({
      name:         'Owner MP',
      email:        `owner-mp-${Date.now()}@test.com`,
      password:     'password123',
      role:         'owner',
      organization: org._id,
      isActive:     true,
    });

    const membership = await OrganizationMember.create({
      user:         owner._id,
      organization: org._id,
      role:         'owner',
      isDebtor:     true,
      balance:      -10000,
    });

    await Unit.create({
      organization: org._id,
      owner:        owner._id,
      name:         'Lote 1',
      status:       'occupied',
      coefficient:  1,
      active:       true,
    });

    mockMPPaymentGet.mockResolvedValue({
      id:                 123456,
      status:             'approved',
      status_detail:      'accredited',
      preference_id:      'pref-123',
      external_reference: `${org._id}|${owner._id}|2026-04|1710000000000`,
    });

    const res = await request(app)
      .post('/api/mercadopago/webhook')
      .set('Content-Type', 'application/json')
      .send({ type: 'payment', data: { id: 123456 } });

    expect(res.status).toBe(200);

    const payment = await waitForPayment(
      { owner: owner._id, month: '2026-04' },
      p => p.mpStatus === 'approved'
    );
    expect(payment).toBeTruthy();
    expect(payment.status).toBe('approved');
    expect(payment.paymentMethod).toBe('mercadopago');
    expect(payment.type).toBe('monthly');
    expect(payment.mpStatus).toBe('approved');
    expect(payment.mpDetail).toBe('accredited');
    expect(payment.mpPaymentId).toBe('123456');
    expect(payment.mpPreferenceId).toBe('pref-123');
    expect(payment.membership.toString()).toBe(membership._id.toString());

    const updatedMembership = await OrganizationMember.findById(membership._id);
    expect(updatedMembership.isDebtor).toBe(false);
    expect(updatedMembership.balance).toBe(0);

    expect(receiptService.generateAndStoreReceipt).toHaveBeenCalledWith(payment._id);
    expect(emailService.sendPaymentApproved).toHaveBeenCalled();
    expect(firebaseService.sendToUser).toHaveBeenCalledWith(
      owner._id,
      expect.objectContaining({
        title: 'Pago aprobado',
        data: expect.objectContaining({ type: 'payment_approved' }),
      })
    );
  });

  test('operación MP approved mantiene pendiente un pago MP preexistente', async () => {
    const org = await Organization.create({
      name:          'Org MP Existing',
      slug:          `org-mp-existing-${Date.now()}`,
      businessType:  'consorcio',
      monthlyFee:    12000,
      mpAccessToken: 'TEST_ACCESS_TOKEN',
    });

    const owner = await User.create({
      name:         'Owner Existing',
      email:        `owner-existing-${Date.now()}@test.com`,
      password:     'password123',
      role:         'owner',
      organization: org._id,
      isActive:     true,
    });

    await Payment.create({
      organization:   org._id,
      owner:          owner._id,
      month:          '2026-05',
      amount:         12000,
      status:         'pending',
      paymentMethod:  'mercadopago',
      mpPreferenceId: 'pref-existing',
    });

    mockMPPaymentGet.mockResolvedValue({
      id:            456789,
      status:        'approved',
      status_detail: 'accredited',
      preference_id: 'pref-existing',
    });

    const res = await request(app)
      .post('/api/mercadopago/webhook')
      .set('Content-Type', 'application/json')
      .send({ type: 'payment', data: { id: 456789 } });

    expect(res.status).toBe(200);

    const payment = await waitForPayment({ owner: owner._id, month: '2026-05', mpPaymentId: '456789' });
    expect(payment).toBeTruthy();
    expect(payment.status).toBe('approved');
    expect(payment.mpStatus).toBe('approved');
    expect(payment.reviewedAt).toBeInstanceOf(Date);
    expect(emailService.sendPaymentApproved).toHaveBeenCalled();
  });
});

describe('GET /api/mercadopago/payment/:mpPaymentId', () => {
  test('approved MP callback concilia y crea pago pendiente si no llegÃ³ webhook', async () => {
    const org = await Organization.create({
      name:          'Org MP Callback',
      slug:          `org-mp-callback-${Date.now()}`,
      businessType:  'consorcio',
      monthlyFee:    15000,
      mpAccessToken: 'TEST_ACCESS_TOKEN',
    });

    const owner = await User.create({
      name:         'Owner Callback',
      email:        `owner-callback-${Date.now()}@test.com`,
      password:     'password123',
      role:         'owner',
      organization: org._id,
      isActive:     true,
    });

    const membership = await OrganizationMember.create({
      user:         owner._id,
      organization: org._id,
      role:         'owner',
      isDebtor:     true,
      balance:      -15000,
    });

    await Unit.create({
      organization: org._id,
      owner:        owner._id,
      name:         'Lote 7',
      status:       'occupied',
      coefficient:  1,
      active:       true,
    });

    mockMPPaymentGet.mockResolvedValue({
      id:                 157681535942,
      status:             'approved',
      status_detail:      'accredited',
      preference_id:      'pref-callback',
      external_reference: `${org._id}|${owner._id}|2026-02|1777918476256`,
    });

    const token = signToken(owner._id, {
      organizationId: org._id,
      role:           'owner',
      membershipId:   membership._id,
    });

    const res = await request(app)
      .get('/api/mercadopago/payment/157681535942')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.payments).toEqual([
      expect.objectContaining({
        month:  '2026-02',
        status: 'approved',
        amount: 15000,
      }),
    ]);

    const payment = await Payment.findOne({ owner: owner._id, month: '2026-02' });
    expect(payment).toBeTruthy();
    expect(payment.status).toBe('approved');
    expect(payment.paymentMethod).toBe('mercadopago');
    expect(payment.type).toBe('monthly');
    expect(payment.mpPaymentId).toBe('157681535942');
    expect(payment.mpStatus).toBe('approved');
    expect(payment.mpPreferenceId).toBe('pref-callback');
    expect(payment.membership.toString()).toBe(membership._id.toString());

    const updatedMembership = await OrganizationMember.findById(membership._id);
    expect(updatedMembership.isDebtor).toBe(false);
    expect(updatedMembership.balance).toBe(0);
  });

  test('approved MP callback de saldo anterior es idempotente', async () => {
    const org = await Organization.create({
      name:          'Org MP Balance Callback',
      slug:          `org-mp-balance-callback-${Date.now()}`,
      businessType:  'consorcio',
      monthlyFee:    1000,
      mpAccessToken: 'TEST_ACCESS_TOKEN',
    });

    const owner = await User.create({
      name:         'Owner Balance Callback',
      email:        `owner-balance-callback-${Date.now()}@test.com`,
      password:     'password123',
      role:         'owner',
      organization: org._id,
      isActive:     true,
    });

    const membership = await OrganizationMember.create({
      user:         owner._id,
      organization: org._id,
      role:         'owner',
      isDebtor:     true,
      balance:      -1095,
    });

    mockMPPaymentGet.mockResolvedValue({
      id:                 157779829724,
      status:             'approved',
      status_detail:      'accredited',
      external_reference: `${org._id}|${owner._id}|v2|||1095|1777976182000`,
    });

    const token = signToken(owner._id, {
      organizationId: org._id,
      role:           'owner',
      membershipId:   membership._id,
    });

    const first = await request(app)
      .get('/api/mercadopago/payment/157779829724')
      .set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .get('/api/mercadopago/payment/157779829724')
      .set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const payments = await Payment.find({
      owner: owner._id,
      organization: org._id,
      type: 'balance',
      mpPaymentId: '157779829724',
    });
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(1095);
    expect(payments[0].status).toBe('approved');

    const updatedMembership = await OrganizationMember.findById(membership._id);
    expect(updatedMembership.balance).toBe(0);
    expect(updatedMembership.isDebtor).toBe(false);
  });
});
