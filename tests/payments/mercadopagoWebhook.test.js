const mockMPPaymentGet = jest.fn();

jest.mock('mercadopago', () => ({
  MercadoPagoConfig: jest.fn().mockImplementation(config => config),
  Preference:        jest.fn(),
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

const request = require('supertest');
const app = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const Organization = require('../../src/models/Organization');
const OrganizationMember = require('../../src/models/OrganizationMember');
const Payment = require('../../src/models/Payment');
const Unit = require('../../src/models/Unit');
const User = require('../../src/models/User');
const emailService = require('../../src/services/emailService');
const firebaseService = require('../../src/services/firebaseService');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  jest.clearAllMocks();
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
    expect(payment.status).toBe('pending');
    expect(payment.paymentMethod).toBe('mercadopago');
    expect(payment.mpStatus).toBe('approved');
    expect(payment.mpDetail).toBe('accredited');
    expect(payment.mpPaymentId).toBe('123456');
    expect(payment.mpPreferenceId).toBe('pref-123');
    expect(payment.membership.toString()).toBe(membership._id.toString());

    const updatedMembership = await OrganizationMember.findById(membership._id);
    expect(updatedMembership.isDebtor).toBe(true);
    expect(updatedMembership.balance).toBe(-10000);

    expect(emailService.sendPaymentApproved).not.toHaveBeenCalled();
    expect(firebaseService.sendToUser).toHaveBeenCalledWith(
      owner._id,
      expect.objectContaining({
        title: 'Pago recibido',
        data: expect.objectContaining({ type: 'payment_pending_approval' }),
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
    expect(payment.status).toBe('pending');
    expect(payment.mpStatus).toBe('approved');
    expect(payment.reviewedAt).toBeUndefined();
    expect(emailService.sendPaymentApproved).not.toHaveBeenCalled();
  });
});
