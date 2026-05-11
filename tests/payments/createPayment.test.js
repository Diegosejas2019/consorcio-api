// Mocks deben ir ANTES de require() del app
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
  sendToUser:     jest.fn().mockResolvedValue(null),
  sendMulticast:  jest.fn().mockResolvedValue([]),
}));
jest.mock('../../src/services/emailService', () => ({
  sendPaymentApproved: jest.fn().mockResolvedValue(null),
  sendPaymentRejected: jest.fn().mockResolvedValue(null),
  sendReceiptEmail:     jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/receiptService', () => ({
  generateAndStoreReceipt: jest.fn().mockImplementation(async (paymentId) => {
    const Payment = require('../../src/models/Payment');
    return Payment.findById(paymentId);
  }),
}));

const request  = require('supertest');
const app      = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createOwnerWithToken, createAdminWithToken } = require('../helpers/factories');
const Payment  = require('../../src/models/Payment');
const OrganizationMember = require('../../src/models/OrganizationMember');
const Unit = require('../../src/models/Unit');

// Buffer mínimo que simula un PDF válido
const FAKE_PDF = Buffer.from('%PDF-1.4 fake content for testing');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  delete process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE;
  await dbHelper.clear();
});

describe('POST /api/payments — subida de comprobante', () => {
  test('rechaza pagos de periodos futuros', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2025-04';
    const { token, orgId } = await createOwnerWithToken();
    const Organization = require('../../src/models/Organization');
    await Organization.findByIdAndUpdate(orgId, { feePeriodCode: '2025-04' });

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('month', '2025-05')
      .field('amount', '15000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('futuros');
  });

  test('1. PDF válido → 201, paymentMethod: manual', async () => {
    const { token } = await createOwnerWithToken();

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('month', '2025-04')
      .field('amount', '15000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.payment.paymentMethod).toBe('manual');
    expect(res.body.data.payment.month).toBe('2025-04');
  });

  test('2. Duplicado con pago pendiente → 400', async () => {
    const { user, token, orgId } = await createOwnerWithToken();

    // Crear pago previo pending directamente
    await Payment.create({
      organization: orgId,
      owner:  user._id,
      month:  '2025-04',
      amount: 15000,
      status: 'pending',
    });

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('month', '2025-04')
      .field('amount', '15000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.message.toLowerCase()).toContain('pendiente');
  });

  test('3. Duplicado con pago aprobado → 400', async () => {
    const { user, token, orgId } = await createOwnerWithToken();

    await Payment.create({
      organization: orgId,
      owner:  user._id,
      month:  '2025-04',
      amount: 15000,
      status: 'approved',
    });

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('month', '2025-04')
      .field('amount', '15000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.message.toLowerCase()).toContain('aprobado');
  });

  test('4. Pago previo rechazado → 201 (permitido re-subir)', async () => {
    const { user, token, orgId } = await createOwnerWithToken();

    await Payment.create({
      organization:  orgId,
      owner:         user._id,
      month:         '2025-04',
      amount:        15000,
      status:        'rejected',
      rejectionNote: 'Comprobante ilegible',
    });

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('month', '2025-04')
      .field('amount', '15000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  test('5. Sin autenticación → 401', async () => {
    const res = await request(app)
      .post('/api/payments')
      .field('month', '2025-04')
      .field('amount', '15000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(401);
  });

  test('6. Sin importe → 400 (validación Mongoose min: 1)', async () => {
    const { token } = await createOwnerWithToken();

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('month', '2025-04')
      .field('amount', '0')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
  });

  test('7. Mes en formato inválido → 400 (regex Mongoose YYYY-MM)', async () => {
    const { token } = await createOwnerWithToken();

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('month', 'abril-2025')
      .field('amount', '15000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
  });

  test('rechaza pago de saldo anterior si supera la deuda pendiente', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    await OrganizationMember.create({
      user: user._id,
      organization: orgId,
      role: 'owner',
      isActive: true,
    });
    await Unit.create({ organization: orgId, owner: user._id, name: 'Lote deuda', balance: -5000, isDebtor: true });

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('amount', '6000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('superar');
  });

  test('permite subir comprobante de deuda inicial usando balanceAmount', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    await OrganizationMember.create({
      user: user._id,
      organization: orgId,
      role: 'owner',
      isActive: true,
    });
    const unit = await Unit.create({ organization: orgId, owner: user._id, name: 'Lote deuda', balance: -5000, isDebtor: true });

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('balanceAmount', '5000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.data.payment.type).toBe('balance');
    expect(res.body.data.payment.amount).toBe(5000);
    expect(res.body.data.payment.units.map(String)).toEqual([unit._id.toString()]);
  });

  test('permite pagar saldo anterior de varias unidades en un comprobante', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    await OrganizationMember.create({
      user: user._id,
      organization: orgId,
      role: 'owner',
      isActive: true,
    });
    const units = await Unit.create([
      { organization: orgId, owner: user._id, name: 'Lote deuda 1', balance: -5000, isDebtor: true },
      { organization: orgId, owner: user._id, name: 'Lote deuda 2', balance: -7000, isDebtor: true },
    ]);

    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .field('balanceAmount', '12000')
      .attach('receipt', FAKE_PDF, { filename: 'comprobante.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.data.payment.type).toBe('balance');
    expect(res.body.data.payment.amount).toBe(12000);
    expect(res.body.data.payment.units.map(String).sort()).toEqual(units.map(u => u._id.toString()).sort());
    expect(res.body.data.payment.breakdown.map(item => item.amount).sort((a, b) => a - b)).toEqual([5000, 7000]);
  });

  test('al aprobar saldo anterior cancela la deuda sin dejar saldo positivo', async () => {
    const { user, orgId } = await createOwnerWithToken();
    const { token: adminToken } = await createAdminWithToken(orgId);
    await OrganizationMember.create({
      user: user._id,
      organization: orgId,
      role: 'owner',
      isActive: true,
    });
    const unit = await Unit.create({ organization: orgId, owner: user._id, name: 'Lote deuda', balance: -5000, isDebtor: true });
    const payment = await Payment.create({
      organization: orgId,
      owner: user._id,
      amount: 5000,
      status: 'pending',
      type: 'balance',
      paymentMethod: 'manual',
      units: [unit._id],
    });

    const res = await request(app)
      .patch(`/api/payments/${payment._id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const updatedUnit = await Unit.findById(unit._id);
    expect(updatedUnit.balance).toBe(0);
    expect(updatedUnit.isDebtor).toBe(false);
  });

});
