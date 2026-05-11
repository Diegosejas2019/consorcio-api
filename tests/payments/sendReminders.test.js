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
  sendMulticast: jest.fn().mockResolvedValue([{ successCount: 1, failureCount: 0, responses: [] }]),
}));
jest.mock('../../src/services/emailService', () => ({
  sendPaymentApproved:  jest.fn().mockResolvedValue(null),
  sendPaymentRejected:  jest.fn().mockResolvedValue(null),
  sendMonthlyReminder:  jest.fn().mockResolvedValue(null),
}));

const request  = require('supertest');
const app      = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createAdminWithToken, createOwnerWithToken } = require('../helpers/factories');
const Organization       = require('../../src/models/Organization');
const OrganizationMember = require('../../src/models/OrganizationMember');
const firebaseService    = require('../../src/services/firebaseService');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  delete process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE;
  jest.clearAllMocks();
  await dbHelper.clear();
});

describe('resolveReminderPeriod', () => {
  test('sin feePeriodCode usa el mes actual si paymentPeriods tiene todo el anio', () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-05';
    const { resolveReminderPeriod } = require('../../src/services/schedulerService');

    const month = resolveReminderPeriod({
      feePeriodCode: '',
      paymentPeriods: [
        '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
        '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
      ],
    });

    expect(month).toBe('2026-05');
  });

  test('sin feePeriodCode no usa periodos futuros como fallback', () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-05';
    const { resolveReminderPeriod } = require('../../src/services/schedulerService');

    expect(resolveReminderPeriod({
      feePeriodCode: '',
      paymentPeriods: ['2026-04', '2026-12'],
    })).toBe('2026-04');
  });
});

describe('POST /api/payments/send-reminders', () => {
  test('admin puede enviar recordatorios manualmente', async () => {
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, { feePeriodCode: '2025-04', monthlyFee: 15000, dueDayOfMonth: 10 });

    const res = await request(app)
      .post('/api/payments/send-reminders')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('sent');
    expect(res.body.data).toHaveProperty('noToken');
  });

  test('sin autenticación → 401', async () => {
    const res = await request(app)
      .post('/api/payments/send-reminders');

    expect(res.status).toBe(401);
  });

  test('owner no puede enviar recordatorios → 403', async () => {
    const { token } = await createOwnerWithToken();

    const res = await request(app)
      .post('/api/payments/send-reminders')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('sin feePeriodCode ni paymentPeriods → responde skipped: true', async () => {
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, { feePeriodCode: '', paymentPeriods: [] });

    const res = await request(app)
      .post('/api/payments/send-reminders')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.skipped).toBe(true);
  });

  test('sin feePeriodCode pero con paymentPeriods → usa el último período como fallback', async () => {
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      feePeriodCode: '',
      paymentPeriods: ['2026-02', '2026-03', '2026-04'],
      monthlyFee: 15000,
    });

    const res = await request(app)
      .post('/api/payments/send-reminders')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.skipped).toBeUndefined();
    expect(res.body.data).toHaveProperty('sent');
  });

  test('envía push a owners con token FCM no pagados', async () => {
    const { token: adminToken, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, { feePeriodCode: '2025-04', monthlyFee: 15000 });

    // Crear un owner con FCM token
    const { user: ownerUser } = await createOwnerWithToken();
    await require('../../src/models/User').findByIdAndUpdate(ownerUser._id, { fcmToken: 'fake-token-123', organization: orgId });
    await OrganizationMember.create({ user: ownerUser._id, organization: orgId, role: 'owner', isActive: true });

    const res = await request(app)
      .post('/api/payments/send-reminders')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(firebaseService.sendMulticast).toHaveBeenCalled();
  });
});
