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
}));

const request  = require('supertest');
const app      = require('../../src/app');
const dbHelper = require('../helpers/dbHelper');
const { createOwnerWithToken } = require('../helpers/factories');
const Expense  = require('../../src/models/Expense');
const Organization = require('../../src/models/Organization');
const Payment  = require('../../src/models/Payment');
const Unit     = require('../../src/models/Unit');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  delete process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE;
  await dbHelper.clear();
});

describe('GET /api/payments - items disponibles para pagar', () => {
  test('no devuelve periodos futuros aunque esten configurados', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2025-04';
    const { token, orgId } = await createOwnerWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      feePeriodCode:  '2025-04',
      paymentPeriods: ['2025-03', '2025-04', '2025-05'],
    });

    const res = await request(app)
      .get('/api/payments/available-items')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.periods).toEqual(['2025-03', '2025-04']);
  });

  test('devuelve el mes calendario actual aunque feePeriodCode haya quedado atrasado', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-05';
    const { token, orgId } = await createOwnerWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      feePeriodCode:  '2026-04',
      paymentPeriods: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'],
    });

    const res = await request(app)
      .get('/api/payments/available-items')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.periods).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
  });

  test('devuelve gastos extraordinarios cobrables disponibles para el owner', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    await Organization.findByIdAndUpdate(orgId, { paymentPeriods: ['2025-04'] });
    const expense = await Expense.create({
      organization: orgId,
      description:  'Arreglo porton',
      category:     'maintenance',
      amount:       40000,
      date:         new Date('2025-04-15T00:00:00.000Z'),
      expenseType:  'extraordinary',
      isChargeable: true,
      createdBy:    user._id,
    });

    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.periods).toContain('2025-04');
    expect(res.body.data.extraordinary).toEqual([
      expect.objectContaining({
        id:     expense._id.toString(),
        title:  'Arreglo porton',
        amount: 40000,
        period: '2025-04',
      }),
    ]);
    expect(res.body.data.availableItems.extraordinary).toHaveLength(1);
    expect(res.body.data.extraordinaryExpenses).toHaveLength(1);
  });

  test('per_unit: devuelve unitAmount * cantidad de unidades del owner', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    await Unit.create({ organization: orgId, owner: user._id, name: 'Lote A', active: true });
    await Unit.create({ organization: orgId, owner: user._id, name: 'Lote B', active: true });
    // Unidad de otro owner (no debe sumarse)
    const otherOwner = { _id: new (require('mongoose').Types.ObjectId)() };
    await Unit.create({ organization: orgId, owner: otherOwner._id, name: 'Lote C', active: true });

    await Expense.create({
      organization: orgId,
      description:  'Luminaria',
      category:     'maintenance',
      amount:       0,
      unitAmount:   1000,
      date:         new Date('2025-04-10'),
      expenseType:  'extraordinary',
      isChargeable: true,
      extraordinaryBillingMode: 'per_unit',
      createdBy:    user._id,
    });

    const res = await request(app).get('/api/payments').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.extraordinary[0].amount).toBe(2000); // 2 unidades × $1000
  });

  test('fixed_total: divide el monto entre las unidades asignadas', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    // 1 unidad del owner, 2 unidades asignadas en la org y 1 unidad vacia
    await Unit.create({ organization: orgId, owner: user._id, name: 'Lote A', active: true });
    const otherOwner = { _id: new (require('mongoose').Types.ObjectId)() };
    await Unit.create({ organization: orgId, owner: otherOwner._id, name: 'Lote B', active: true });
    await Unit.create({ organization: orgId, name: 'Lote C', active: true });

    await Expense.create({
      organization: orgId,
      description:  'Portón automático',
      category:     'maintenance',
      amount:       10000,
      date:         new Date('2025-04-10'),
      expenseType:  'extraordinary',
      isChargeable: true,
      extraordinaryBillingMode: 'fixed_total',
      createdBy:    user._id,
    });

    const res = await request(app).get('/api/payments').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.extraordinary[0].amount).toBe(5000); // 10000 / 2 unidades asignadas x 1
  });

  test('by_coefficient: calcula monto ponderado por coeficiente', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    await Unit.create({ organization: orgId, owner: user._id, name: 'Lote A', coefficient: 0.3, active: true });
    const otherOwner = { _id: new (require('mongoose').Types.ObjectId)() };
    await Unit.create({ organization: orgId, owner: otherOwner._id, name: 'Lote B', coefficient: 0.7, active: true });

    await Expense.create({
      organization: orgId,
      description:  'Pintura fachada',
      category:     'maintenance',
      amount:       10000,
      date:         new Date('2025-04-10'),
      expenseType:  'extraordinary',
      isChargeable: true,
      extraordinaryBillingMode: 'by_coefficient',
      createdBy:    user._id,
    });

    const res = await request(app).get('/api/payments').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.extraordinary[0].amount).toBe(3000); // 10000 × (0.3 / 1.0)
  });

  test('per_unit sin unidades del owner: no aparece en la lista', async () => {
    const { token, orgId, user } = await createOwnerWithToken();
    // El owner no tiene units, pero hay una unidad de otro en la org
    const otherOwner = { _id: new (require('mongoose').Types.ObjectId)() };
    await Unit.create({ organization: orgId, owner: otherOwner._id, name: 'Lote X', active: true });

    await Expense.create({
      organization: orgId,
      description:  'Gasto solo para lote X',
      category:     'maintenance',
      amount:       0,
      unitAmount:   500,
      date:         new Date('2025-04-10'),
      expenseType:  'extraordinary',
      isChargeable: true,
      extraordinaryBillingMode: 'per_unit',
      createdBy:    user._id,
    });

    const res = await request(app).get('/api/payments').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.extraordinary).toHaveLength(0);
  });

  test('no devuelve extraordinarios ya incluidos en pagos activos del owner', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    const expense = await Expense.create({
      organization: orgId,
      description:  'Bomba de agua',
      category:     'maintenance',
      amount:       25000,
      date:         new Date('2025-04-20T00:00:00.000Z'),
      expenseType:  'extraordinary',
      isChargeable: true,
      createdBy:    user._id,
    });
    await Payment.create({
      organization: orgId,
      owner:        user._id,
      amount:       25000,
      status:       'pending',
      type:         'extraordinary',
      extraordinaryItems: [{ expense: expense._id, amount: 25000 }],
    });

    const res = await request(app)
      .get('/api/payments/available-items')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.extraordinary).toHaveLength(0);
  });
});
