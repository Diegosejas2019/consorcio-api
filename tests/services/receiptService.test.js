jest.mock('../../src/config/cloudinary', () => ({
  cloudinary: {
    uploader: {
      upload: jest.fn().mockResolvedValue({
        secure_url: 'https://cloudinary.test/recibo.pdf',
        public_id: 'consorcio/recibos/recibo_REC-00000011',
      }),
    },
  },
}));

jest.mock('puppeteer', () => ({
  launch: jest.fn(),
}));

const dbHelper = require('../helpers/dbHelper');
const { createOwnerWithToken } = require('../helpers/factories');
const Organization = require('../../src/models/Organization');
const Payment = require('../../src/models/Payment');
const puppeteer = require('puppeteer');
const receiptService = require('../../src/services/receiptService');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  jest.clearAllMocks();
  await dbHelper.clear();
});

describe('receiptService.generateAndStoreReceipt', () => {
  test('reutiliza el numero reservado si falla Puppeteer', async () => {
    const { user, orgId } = await createOwnerWithToken();
    await Organization.findByIdAndUpdate(orgId, { receiptCounter: 10 });
    const payment = await Payment.create({
      organization: orgId,
      owner:        user._id,
      month:        '2026-04',
      amount:       15000,
      status:       'approved',
    });

    puppeteer.launch.mockRejectedValue(new Error('Could not find Chrome (ver. 147.0.7727.57)'));

    await expect(receiptService.generateAndStoreReceipt(payment._id)).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(receiptService.generateAndStoreReceipt(payment._id)).rejects.toMatchObject({
      statusCode: 503,
    });

    const [updatedPayment, updatedOrg] = await Promise.all([
      Payment.findById(payment._id).lean(),
      Organization.findById(orgId).lean(),
    ]);

    expect(updatedPayment.receiptNumber).toBe('REC-00000011');
    expect(updatedPayment.systemReceipt?.url).toBeUndefined();
    expect(updatedOrg.receiptCounter).toBe(11);
  });
});
