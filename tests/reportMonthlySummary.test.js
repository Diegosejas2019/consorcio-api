jest.mock('../src/config/cloudinary', () => {
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

const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createAdminWithToken } = require('./helpers/factories');
const Expense = require('../src/models/Expense');
const ExpenseCategory = require('../src/models/ExpenseCategory');
const Organization = require('../src/models/Organization');
const Payment = require('../src/models/Payment');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

describe('informe mensual', () => {
  test('suma todos los gastos activos del periodo y respeta organizacion', async () => {
    const { user, token, orgId } = await createAdminWithToken();
    const otherOrg = await Organization.create({
      name: 'Otra Org',
      slug: 'otra-org',
      businessType: 'consorcio',
    });

    await ExpenseCategory.create({
      organization: orgId,
      key: 'jardineria',
      label: 'Jardineria',
      createdBy: user._id,
    });

    await Payment.create([
      { organization: orgId, owner: user._id, amount: 1000, status: 'approved', month: '2026-05' },
      { organization: orgId, owner: user._id, amount: 300, status: 'approved', month: '2026-04' },
    ]);

    await Expense.create([
      {
        organization: orgId,
        description: 'Corte de cesped',
        category: 'jardineria',
        amount: 100,
        date: new Date('2026-05-01T00:00:00.000Z'),
        status: 'pending',
        createdBy: user._id,
      },
      {
        organization: orgId,
        description: 'Limpieza mensual',
        category: 'cleaning',
        amount: 200,
        date: new Date('2026-05-15T12:00:00.000Z'),
        status: 'paid',
        createdBy: user._id,
      },
      {
        organization: orgId,
        description: 'Gasto eliminado',
        category: 'maintenance',
        amount: 300,
        date: new Date('2026-05-18T12:00:00.000Z'),
        status: 'paid',
        isActive: false,
        createdBy: user._id,
      },
      {
        organization: orgId,
        description: 'Saldo anterior',
        category: 'other',
        amount: 50,
        date: new Date('2026-04-20T12:00:00.000Z'),
        status: 'pending',
        createdBy: user._id,
      },
      {
        organization: otherOrg._id,
        description: 'Otro tenant',
        category: 'cleaning',
        amount: 400,
        date: new Date('2026-05-12T12:00:00.000Z'),
        status: 'paid',
        createdBy: user._id,
      },
    ]);

    const res = await request(app)
      .get('/api/reports/monthly-summary?month=2026-05')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.income.total).toBe(1000);
    expect(res.body.data.expenses.jardineria).toBe(100);
    expect(res.body.data.expenses.cleaning).toBe(200);
    expect(res.body.data.expenses.maintenance).toBe(0);
    expect(res.body.data.expenses.total).toBe(300);
    expect(res.body.data.saldoAnterior).toBe(250);
    expect(res.body.data.balance).toBe(950);
    expect(res.body.data.expenseCategories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'jardineria', label: 'Jardineria', amount: 100 }),
        expect.objectContaining({ key: 'cleaning', label: 'Limpieza', amount: 200 }),
      ])
    );
  });
});
