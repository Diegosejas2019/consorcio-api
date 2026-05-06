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
const { createAdminWithToken, createOwnerWithToken } = require('./helpers/factories');
const Employee = require('../src/models/Employee');
const Expense = require('../src/models/Expense');
const Salary = require('../src/models/Salary');
const SalaryPayment = require('../src/models/SalaryPayment');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function createEmployee(orgId, userId, overrides = {}) {
  return Employee.create({
    organization: orgId,
    name: 'Juan Perez',
    role: 'maintenance',
    isActive: true,
    createdBy: userId,
    ...overrides,
  });
}

async function createSalaryViaApi(token, employeeId, overrides = {}) {
  return request(app)
    .post('/api/salaries')
    .set('Authorization', `Bearer ${token}`)
    .send({
      employeeId,
      period: '2026-05',
      baseAmount: 150,
      extraAmount: 0,
      deductions: 0,
      ...overrides,
    });
}

describe('adelantos y pagos parciales de sueldo', () => {
  test('crea un movimiento valido y recalcula sueldo sin pagar el gasto completo', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    const salaryRes = await createSalaryViaApi(token, employee._id);
    const salaryId = salaryRes.body.data.salary._id;

    const res = await request(app)
      .post('/api/salary-payments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        salary: salaryId,
        type: 'advance',
        amount: 50,
        paymentMethod: 'cash',
        paymentDate: '2026-05-01',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.salaryPayment.type).toBe('advance');
    expect(res.body.data.salary.status).toBe('partially_paid');
    expect(res.body.data.salary.paidAmount).toBe(50);
    expect(res.body.data.salary.remainingAmount).toBe(100);

    const salary = await Salary.findById(salaryId);
    const expense = await Expense.findById(salary.expenseId);
    expect(salary.status).toBe('partially_paid');
    expect(expense.amount).toBe(150);
    expect(expense.status).toBe('pending');
    expect(await Expense.countDocuments({ organization: orgId, category: 'salaries' })).toBe(1);
  });

  test('bloquea un pago mayor al saldo pendiente', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    const salaryRes = await createSalaryViaApi(token, employee._id);

    const res = await request(app)
      .post('/api/salary-payments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        salary: salaryRes.body.data.salary._id,
        type: 'salary_payment',
        amount: 200,
        paymentMethod: 'transfer',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('El monto ingresado supera el saldo pendiente del sueldo.');
  });

  test('completa el sueldo y marca el gasto como pagado solo al llegar al total', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    const salaryRes = await createSalaryViaApi(token, employee._id);
    const salaryId = salaryRes.body.data.salary._id;

    await request(app)
      .post('/api/salary-payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ salary: salaryId, type: 'advance', amount: 50, paymentMethod: 'cash' });

    const finalRes = await request(app)
      .post('/api/salary-payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ salary: salaryId, type: 'salary_payment', amount: 100, paymentMethod: 'transfer' });

    expect(finalRes.status).toBe(201);
    expect(finalRes.body.data.salary.status).toBe('paid');
    expect(finalRes.body.data.salary.paidAmount).toBe(150);
    expect(finalRes.body.data.salary.remainingAmount).toBe(0);

    const salary = await Salary.findById(salaryId);
    const expense = await Expense.findById(salary.expenseId);
    expect(expense.status).toBe('paid');
    expect(expense.amount).toBe(150);
  });

  test('soft-delete de movimiento recalcula el sueldo y vuelve el gasto a pendiente', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    const salaryRes = await createSalaryViaApi(token, employee._id);
    const salaryId = salaryRes.body.data.salary._id;

    const paymentRes = await request(app)
      .post('/api/salary-payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ salary: salaryId, type: 'salary_payment', amount: 150, paymentMethod: 'cash' });

    const paymentId = paymentRes.body.data.salaryPayment._id;
    const deleteRes = await request(app)
      .delete(`/api/salary-payments/${paymentId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.data.salary.status).toBe('pending');
    expect(deleteRes.body.data.salary.paidAmount).toBe(0);
    expect(deleteRes.body.data.salary.remainingAmount).toBe(150);

    const payment = await SalaryPayment.findById(paymentId);
    const salary = await Salary.findById(salaryId);
    const expense = await Expense.findById(salary.expenseId);
    expect(payment.isActive).toBe(false);
    expect(expense.status).toBe('pending');
  });

  test('el flujo legacy de marcar sueldo como pagado crea el movimiento faltante', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    const salaryRes = await createSalaryViaApi(token, employee._id);
    const salaryId = salaryRes.body.data.salary._id;

    const res = await request(app)
      .patch(`/api/salaries/${salaryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'paid', paymentMethod: 'transfer', paymentDate: '2026-05-31' });

    expect(res.status).toBe(200);
    expect(res.body.data.salary.status).toBe('paid');
    expect(res.body.data.salary.paidAmount).toBe(150);
    expect(await SalaryPayment.countDocuments({ salary: salaryId, isActive: { $ne: false } })).toBe(1);
    expect(await Expense.countDocuments({ organization: orgId, category: 'salaries' })).toBe(1);
  });

  test('bloquea pagos sobre sueldo pagado o cancelado', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    const paidSalaryRes = await createSalaryViaApi(token, employee._id);

    await request(app)
      .patch(`/api/salaries/${paidSalaryRes.body.data.salary._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'paid', paymentMethod: 'cash' });

    const paidAttempt = await request(app)
      .post('/api/salary-payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ salary: paidSalaryRes.body.data.salary._id, amount: 1, paymentMethod: 'cash' });

    const cancelledSalaryRes = await createSalaryViaApi(token, employee._id, { period: '2026-06' });
    await request(app)
      .delete(`/api/salaries/${cancelledSalaryRes.body.data.salary._id}`)
      .set('Authorization', `Bearer ${token}`);

    const cancelledAttempt = await request(app)
      .post('/api/salary-payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ salary: cancelledSalaryRes.body.data.salary._id, amount: 1, paymentMethod: 'cash' });

    expect(paidAttempt.status).toBe(400);
    expect(cancelledAttempt.status).toBe(400);
  });

  test('impide bajar el total por debajo del monto ya pagado', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    const salaryRes = await createSalaryViaApi(token, employee._id);
    const salaryId = salaryRes.body.data.salary._id;

    await request(app)
      .post('/api/salary-payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ salary: salaryId, type: 'advance', amount: 100, paymentMethod: 'cash' });

    const res = await request(app)
      .patch(`/api/salaries/${salaryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ baseAmount: 80, extraAmount: 0, deductions: 0 });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('El total del sueldo no puede ser menor al monto ya pagado.');
  });

  test('no permite acceder a sueldos de otra organizacion', async () => {
    const adminA = await createAdminWithToken();
    const adminB = await createAdminWithToken();
    const employee = await createEmployee(adminA.orgId, adminA.user._id);
    const salaryRes = await createSalaryViaApi(adminA.token, employee._id);

    const res = await request(app)
      .post('/api/salary-payments')
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ salary: salaryRes.body.data.salary._id, amount: 10, paymentMethod: 'cash' });

    expect(res.status).toBe(404);
    expect(await SalaryPayment.countDocuments()).toBe(0);
  });

  test('owner no puede gestionar movimientos de sueldo', async () => {
    const { token } = await createOwnerWithToken();

    const res = await request(app)
      .get('/api/salary-payments')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
