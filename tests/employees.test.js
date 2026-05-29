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
const Organization = require('../src/models/Organization');
const User = require('../src/models/User');
const OrganizationMember = require('../src/models/OrganizationMember');
const Employee = require('../src/models/Employee');
const Expense = require('../src/models/Expense');
const Salary = require('../src/models/Salary');
const { signToken } = require('../src/middleware/auth');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function createSecurityGuardToken(orgId) {
  const user = await User.create({
    name: 'Guard Test',
    email: `guard-${Date.now()}@test.com`,
    password: 'password123',
    role: 'admin',
    organization: orgId,
    isActive: true,
  });
  const membership = await OrganizationMember.create({
    user: user._id,
    organization: orgId,
    role: 'admin',
    adminRole: 'security_guard',
    isActive: true,
  });
  const token = signToken(user._id, {
    organizationId: orgId,
    role: 'admin',
    membershipId: membership._id,
    accessType: 'admin',
    adminRole: 'security_guard',
  });
  return { user, token };
}

async function createEmployee(orgId, userId, overrides = {}) {
  return Employee.create({
    organization: orgId,
    name: 'Ana Lopez',
    role: 'cleaning',
    isActive: true,
    createdBy: userId,
    ...overrides,
  });
}

async function createSalary(orgId, employeeId, userId, overrides = {}) {
  return Salary.create({
    organization: orgId,
    employee: employeeId,
    period: '2026-05',
    baseAmount: 200,
    extraAmount: 0,
    deductions: 0,
    totalAmount: 200,
    paidAmount: 0,
    remainingAmount: 200,
    status: 'pending',
    createdBy: userId,
    ...overrides,
  });
}

describe('empleados — multi-tenant y permisos', () => {
  test('admin crea empleado en su organizacion', async () => {
    const { token, orgId } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Carlos Gomez', role: 'maintenance' });

    expect(res.status).toBe(201);
    expect(res.body.data.employee.organization).toBe(String(orgId));
    expect(res.body.data.employee.name).toBe('Carlos Gomez');
  });

  test('admin lista solo empleados de su organizacion', async () => {
    const adminA = await createAdminWithToken();
    const adminB = await createAdminWithToken();

    await createEmployee(adminA.orgId, adminA.user._id, { name: 'Empleado A' });
    await createEmployee(adminB.orgId, adminB.user._id, { name: 'Empleado B' });

    const res = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${adminA.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.employees).toHaveLength(1);
    expect(res.body.data.employees[0].name).toBe('Empleado A');
  });

  test('admin de otra organizacion no puede ver ni editar empleados ajenos', async () => {
    const adminA = await createAdminWithToken();
    const adminB = await createAdminWithToken();
    const employee = await createEmployee(adminA.orgId, adminA.user._id);

    const getRes = await request(app)
      .get(`/api/employees/${employee._id}`)
      .set('Authorization', `Bearer ${adminB.token}`);

    const patchRes = await request(app)
      .patch(`/api/employees/${employee._id}`)
      .set('Authorization', `Bearer ${adminB.token}`)
      .send({ name: 'Hackeado' });

    const deleteRes = await request(app)
      .delete(`/api/employees/${employee._id}`)
      .set('Authorization', `Bearer ${adminB.token}`);

    expect(getRes.status).toBe(404);
    expect(patchRes.status).toBe(404);
    expect(deleteRes.status).toBe(404);
  });

  test('owner no puede acceder a empleados', async () => {
    const { token } = await createOwnerWithToken();

    const getRes = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${token}`);

    const postRes = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Intruso', role: 'admin' });

    expect(getRes.status).toBe(403);
    expect(postRes.status).toBe(403);
  });

  test('security_guard no puede acceder a empleados ni sueldos', async () => {
    const { orgId } = await createAdminWithToken();
    const { token: guardToken } = await createSecurityGuardToken(orgId);

    const empRes = await request(app)
      .get('/api/employees')
      .set('Authorization', `Bearer ${guardToken}`);

    const salRes = await request(app)
      .get('/api/salaries')
      .set('Authorization', `Bearer ${guardToken}`);

    expect(empRes.status).toBe(403);
    expect(salRes.status).toBe(403);
  });

  test('no se puede dar de baja empleado con sueldo pending', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    await createSalary(orgId, employee._id, user._id, { status: 'pending' });

    const res = await request(app)
      .delete(`/api/employees/${employee._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/pendientes/);
    const emp = await Employee.findById(employee._id);
    expect(emp.isActive).toBe(true);
  });

  test('no se puede dar de baja empleado con sueldo partially_paid', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    await createSalary(orgId, employee._id, user._id, {
      status: 'partially_paid',
      paidAmount: 100,
      remainingAmount: 100,
    });

    const res = await request(app)
      .delete(`/api/employees/${employee._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/parcialmente pagados/);
    const emp = await Employee.findById(employee._id);
    expect(emp.isActive).toBe(true);
  });

  test('si el sueldo esta pagado o cancelado, permite dar de baja al empleado', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);
    await createSalary(orgId, employee._id, user._id, { status: 'paid' });

    const res = await request(app)
      .delete(`/api/employees/${employee._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const emp = await Employee.findById(employee._id);
    expect(emp.isActive).toBe(false);
  });
});

describe('salarios — sueldo duplicado no deja Expense huerfano', () => {
  test('crear sueldo duplicado retorna 409 y no crea Expense extra', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);

    const first = await request(app)
      .post('/api/salaries')
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeId: employee._id, period: '2026-05', baseAmount: 200 });

    expect(first.status).toBe(201);
    expect(await Expense.countDocuments({ organization: orgId, category: 'salaries' })).toBe(1);

    const second = await request(app)
      .post('/api/salaries')
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeId: employee._id, period: '2026-05', baseAmount: 200 });

    expect(second.status).toBe(409);
    expect(await Expense.countDocuments({ organization: orgId, category: 'salaries' })).toBe(1);
    expect(await Salary.countDocuments({ organization: orgId })).toBe(1);
  });

  test('periodos distintos del mismo empleado crean salarios independientes', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const employee = await createEmployee(orgId, user._id);

    await request(app)
      .post('/api/salaries')
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeId: employee._id, period: '2026-04', baseAmount: 200 });

    const res = await request(app)
      .post('/api/salaries')
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeId: employee._id, period: '2026-05', baseAmount: 200 });

    expect(res.status).toBe(201);
    expect(await Salary.countDocuments({ organization: orgId })).toBe(2);
    expect(await Expense.countDocuments({ organization: orgId, category: 'salaries' })).toBe(2);
  });
});
