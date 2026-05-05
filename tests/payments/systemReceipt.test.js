jest.mock('../../src/config/cloudinary', () => {
  const multer = require('multer');
  const memoryUpload = multer({ storage: multer.memoryStorage() });
  return {
    upload: memoryUpload,
    uploadProvider: memoryUpload,
    uploadClaim: memoryUpload,
    uploadNotice: memoryUpload,
    uploadEmployee: memoryUpload,
    deleteCloudinaryAttachments: jest.fn().mockResolvedValue(null),
    cloudinary: {
      uploader: { destroy: jest.fn().mockResolvedValue({}) },
      utils:    { private_download_url: jest.fn().mockReturnValue('https://signed.example.com/recibo.pdf') },
    },
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
  generateAndStoreReceipt: jest.fn(),
}));

const request        = require('supertest');
const app            = require('../../src/app');
const dbHelper       = require('../helpers/dbHelper');
const { createOwnerWithToken } = require('../helpers/factories');
const Payment        = require('../../src/models/Payment');
const receiptService = require('../../src/services/receiptService');
const originalFetch  = global.fetch;

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  jest.clearAllMocks();
  global.fetch = originalFetch;
  await dbHelper.clear();
});

describe('GET /api/payments/:id/system-receipt', () => {
  test('rechaza ids de pago invalidos sin consultar Mongo', async () => {
    const { token } = await createOwnerWithToken();

    const res = await request(app)
      .get('/api/payments/69f930635e30caf')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('identificador');
  });

  test('devuelve el recibo generado de un pago aprobado', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    const payment = await Payment.create({
      organization: orgId,
      owner:        user._id,
      month:        '2026-04',
      amount:       15000,
      status:       'approved',
      systemReceipt: { url: 'https://cdn.example.com/recibo.pdf', publicId: 'recibo_1' },
      receiptNumber: 'REC-00000001',
      receiptIssuedAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    const res = await request(app)
      .get(`/api/payments/${payment._id}/system-receipt`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe('https://cdn.example.com/recibo.pdf');
    expect(res.body.data.receiptNumber).toBe('REC-00000001');
    expect(receiptService.generateAndStoreReceipt).not.toHaveBeenCalled();
  });

  test('descarga el recibo como PDF autenticado', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    const payment = await Payment.create({
      organization: orgId,
      owner:        user._id,
      month:        '2026-04',
      amount:       15000,
      status:       'approved',
      systemReceipt: { url: 'https://cdn.example.com/recibo.pdf', publicId: 'recibo_1' },
      receiptNumber: 'REC-00000001',
      receiptIssuedAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok:      true,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? '4' : null) },
      body:    new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
          controller.close();
        },
      }),
    });

    const res = await request(app)
      .get(`/api/payments/${payment._id}/system-receipt?download=1`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('filename="REC-00000001.pdf"');
    const { cloudinary } = require('../../src/config/cloudinary');
    expect(cloudinary.utils.private_download_url).toHaveBeenCalledWith(
      'recibo_1',
      'pdf',
      expect.objectContaining({ resource_type: 'raw', type: 'upload' })
    );
    expect(global.fetch).toHaveBeenCalledWith('https://signed.example.com/recibo.pdf');
  });

  test('genera el recibo bajo demanda para pagos aprobados historicos sin PDF', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    const payment = await Payment.create({
      organization: orgId,
      owner:        user._id,
      month:        '2026-03',
      amount:       15000,
      status:       'approved',
    });

    receiptService.generateAndStoreReceipt.mockImplementation(async (paymentId) => {
      return Payment.findByIdAndUpdate(
        paymentId,
        {
          systemReceipt: { url: 'https://cdn.example.com/generated.pdf', publicId: 'recibo_2' },
          receiptNumber: 'REC-00000002',
          receiptIssuedAt: new Date('2026-05-02T00:00:00.000Z'),
        },
        { new: true }
      );
    });

    const res = await request(app)
      .get(`/api/payments/${payment._id}/system-receipt`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe('https://cdn.example.com/generated.pdf');
    expect(receiptService.generateAndStoreReceipt).toHaveBeenCalledWith(payment._id);
  });

  test('rechaza recibos de pagos no aprobados', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    const payment = await Payment.create({
      organization: orgId,
      owner:        user._id,
      month:        '2026-04',
      amount:       15000,
      status:       'pending',
    });

    const res = await request(app)
      .get(`/api/payments/${payment._id}/system-receipt`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('pagos aprobados');
    expect(receiptService.generateAndStoreReceipt).not.toHaveBeenCalled();
  });
});
