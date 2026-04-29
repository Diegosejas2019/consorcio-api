// Mocks deben ir ANTES de require() del app
jest.mock('../../src/config/cloudinary', () => {
  const multer = require('multer');
  const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  return {
    upload: memoryUpload,
    uploadProvider: memoryUpload,
    uploadClaim: memoryUpload,
    uploadNotice: memoryUpload,
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
}));

const request  = require('supertest');
const app      = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createOwnerWithToken } = require('../helpers/factories');
const Payment  = require('../../src/models/Payment');

// Buffer mínimo que simula un PDF válido
const FAKE_PDF = Buffer.from('%PDF-1.4 fake content for testing');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

describe('POST /api/payments — subida de comprobante', () => {

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

});
