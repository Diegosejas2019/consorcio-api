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
const ExpenseCategory = require('../src/models/ExpenseCategory');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

describe('categorias dinamicas de gastos', () => {
  test('lista categorias default por organizacion', async () => {
    const { token } = await createAdminWithToken();

    const res = await request(app)
      .get('/api/expenses/categories')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'maintenance', label: 'Mantenimiento' }),
        expect.objectContaining({ key: 'salaries', label: 'Sueldos' }),
      ])
    );
  });

  test('permite agregar categoria y crear un gasto con ella', async () => {
    const { token } = await createAdminWithToken();

    const categoryRes = await request(app)
      .post('/api/expenses/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Jardineria' });

    expect(categoryRes.status).toBe(201);
    expect(categoryRes.body.data.category.key).toBe('jardineria');

    const expenseRes = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({
        description: 'Corte de cesped',
        category: 'jardineria',
        amount: 15000,
        date: '2026-05-01',
      });

    expect(expenseRes.status).toBe(201);
    expect(expenseRes.body.data.expense.category).toBe('jardineria');
  });

  test('rechaza crear gasto con categoria inexistente', async () => {
    const { token } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({
        description: 'Gasto raro',
        category: 'no_existe',
        amount: 1000,
        date: '2026-05-01',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Categoria de gasto no valida');
  });

  test('no mezcla categorias entre organizaciones', async () => {
    const adminA = await createAdminWithToken();
    const adminB = await createAdminWithToken();

    await request(app)
      .post('/api/expenses/categories')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ label: 'Jardineria' });

    const res = await request(app)
      .get('/api/expenses/categories')
      .set('Authorization', `Bearer ${adminB.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.categories).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'jardineria' })])
    );
    expect(await ExpenseCategory.countDocuments({ key: 'jardineria' })).toBe(1);
  });
});
