jest.mock('../src/config/cloudinary', () => {
  const multer = require('multer');
  const mem = multer({ storage: multer.memoryStorage() });
  return {
    upload: mem, uploadProvider: mem, uploadClaim: mem,
    uploadNotice: mem, uploadEmployee: mem, uploadOrganizationDocument: mem,
    deleteCloudinaryAttachments: jest.fn().mockResolvedValue(null),
    cloudinary: {
      uploader: {
        destroy: jest.fn().mockResolvedValue({}),
        upload_stream: jest.fn((opts, cb) => {
          const { Readable } = require('stream');
          const passthrough = new (require('stream').PassThrough)();
          process.nextTick(() => cb(null, { secure_url: 'https://cloudinary.test/receipt.pdf', public_id: 'test/receipt' }));
          return passthrough;
        }),
      },
      utils: { private_download_url: jest.fn().mockReturnValue('https://cloudinary.test/doc') },
    },
  };
});

jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock')),
    }),
    close: jest.fn().mockResolvedValue(undefined),
  }),
}));

const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createAdminWithToken, createOwnerWithToken } = require('./helpers/factories');
const Organization = require('../src/models/Organization');
const User = require('../src/models/User');
const OrganizationMember = require('../src/models/OrganizationMember');
const Employee = require('../src/models/Employee');
const Expense  = require('../src/models/Expense');
const Salary   = require('../src/models/Salary');
const SalaryPayment = require('../src/models/SalaryPayment');
const OrganizationFeature = require('../src/models/OrganizationFeature');
const PayrollSetting = require('../src/models/PayrollSetting');
const EmployeePayrollProfile = require('../src/models/EmployeePayrollProfile');
const PayrollRuleVersion = require('../src/models/PayrollRuleVersion');
const PayrollLiquidation = require('../src/models/PayrollLiquidation');
const { signToken } = require('../src/middleware/auth');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

// ── Helpers ────────────────────────────────────────────────────

async function enableLegalPayroll(orgId) {
  await OrganizationFeature.findOneAndUpdate(
    { organization: orgId, featureKey: 'legalPayroll' },
    { organization: orgId, featureKey: 'legalPayroll', enabled: true },
    { upsert: true }
  );
}

async function createEmployee(orgId, userId, overrides = {}) {
  return Employee.create({ organization: orgId, name: 'Ana Lopez', role: 'cleaning', isActive: true, createdBy: userId, ...overrides });
}

async function createPayrollSetting(orgId, userId) {
  return PayrollSetting.create({
    organization: orgId, employerLegalName: 'Consorcio Test SA', employerCuit: '30999999990',
    employerAddress: 'Av. Test 123', defaultPaymentMethod: 'transfer', active: true, createdBy: userId,
  });
}

async function createProfile(orgId, employeeId, userId, overrides = {}) {
  return EmployeePayrollProfile.create({
    organization: orgId, employee: employeeId,
    cuil: '20999999990', hireDate: new Date('2020-01-01'),
    baseSalary: 100000, employmentType: 'permanent', workSchedule: 'full_time',
    active: true, createdBy: userId,
    baseSalaryHistory: [{ amount: 100000, effectiveFrom: new Date('2020-01-01') }],
    ...overrides,
  });
}

async function createRuleVersion(overrides = {}) {
  return PayrollRuleVersion.create({
    version: overrides.version || 'AR-TEST-01',
    country: 'AR',
    effectiveFrom: overrides.effectiveFrom || new Date('2020-01-01'),
    effectiveTo: overrides.effectiveTo,
    rules: new Map([['jubilacion_empleado', 0.11], ['obra_social_empleado', 0.03]]),
    source: 'Test',
    notes: 'Test rules',
  });
}

async function createSecurityGuardToken(orgId) {
  const user = await User.create({ name: 'Guard', email: `guard-${Date.now()}@test.com`, password: 'password123', role: 'admin', organization: orgId, isActive: true });
  const membership = await OrganizationMember.create({ user: user._id, organization: orgId, role: 'admin', adminRole: 'security_guard', isActive: true });
  const token = signToken(user._id, { organizationId: orgId, role: 'admin', membershipId: membership._id, accessType: 'admin', adminRole: 'security_guard' });
  return { user, token };
}

// ── Tests ──────────────────────────────────────────────────────

describe('payroll — feature flag', () => {
  test('organización sin legalPayroll habilitado recibe 403 en /liquidations', async () => {
    const { token } = await createAdminWithToken();
    const res = await request(app).get('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('organización con legalPayroll habilitado puede listar liquidaciones', async () => {
    const { token, orgId } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    const res = await request(app).get('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('payroll — permisos de acceso', () => {
  test('owner no puede acceder a ningún endpoint de payroll', async () => {
    const { token } = await createOwnerWithToken();
    const res = await request(app).get('/api/payroll/settings').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('security_guard no puede acceder a perfiles laborales', async () => {
    const { orgId } = await createAdminWithToken();
    const { token } = await createSecurityGuardToken(orgId);
    const res = await request(app).get('/api/payroll/employee-profiles').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('security_guard no puede acceder a settings de payroll', async () => {
    const { orgId } = await createAdminWithToken();
    const { token } = await createSecurityGuardToken(orgId);
    const res = await request(app).get('/api/payroll/settings').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('payroll — multi-tenant', () => {
  test('admin de org A no ve perfiles laborales de org B', async () => {
    const adminA = await createAdminWithToken();
    const adminB = await createAdminWithToken();
    const empB = await createEmployee(adminB.orgId, adminB.user._id);
    await createProfile(adminB.orgId, empB._id, adminB.user._id);

    const res = await request(app).get('/api/payroll/employee-profiles').set('Authorization', `Bearer ${adminA.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.profiles).toHaveLength(0);
  });

  test('admin de org A no ve liquidaciones de org B', async () => {
    const adminA = await createAdminWithToken();
    const adminB = await createAdminWithToken();
    await enableLegalPayroll(adminA.orgId);
    await enableLegalPayroll(adminB.orgId);
    const empB = await createEmployee(adminB.orgId, adminB.user._id);
    await PayrollLiquidation.create({ organization: adminB.orgId, employee: empB._id, period: '2025-06', liquidationType: 'monthly', createdBy: adminB.user._id });

    const res = await request(app).get('/api/payroll/liquidations').set('Authorization', `Bearer ${adminA.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.liquidations).toHaveLength(0);
  });
});

describe('payroll — PayrollSetting', () => {
  test('admin puede crear/actualizar configuración de empleador', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const res = await request(app).put('/api/payroll/settings').set('Authorization', `Bearer ${token}`)
      .send({ employerLegalName: 'Test SA', employerCuit: '30999999990' });
    expect(res.status).toBe(200);
    expect(res.body.data.payrollSetting.employerLegalName).toBe('Test SA');
  });

  test('sin configuración de empleador no se puede crear liquidación', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    const emp = await createEmployee(orgId, user._id);
    await createProfile(orgId, emp._id, user._id);

    const res = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06', liquidationType: 'monthly' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/configuración de empleador/i);
  });
});

describe('payroll — EmployeePayrollProfile', () => {
  test('sin perfil laboral no se puede crear liquidación', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    await createPayrollSetting(orgId, user._id);
    const emp = await createEmployee(orgId, user._id);

    const res = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06', liquidationType: 'monthly' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/perfil laboral/i);
  });

  test('cuil y cbu no aparecen en el listado de perfiles', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const emp = await createEmployee(orgId, user._id);
    await createProfile(orgId, emp._id, user._id);

    const res = await request(app).get('/api/payroll/employee-profiles').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.profiles[0]).not.toHaveProperty('cuil');
    expect(res.body.data.profiles[0]).not.toHaveProperty('cbu');
  });

  test('cuil aparece en el detalle de perfil', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const emp = await createEmployee(orgId, user._id);
    const profile = await createProfile(orgId, emp._id, user._id);

    const res = await request(app).get(`/api/payroll/employee-profiles/${profile._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.profile).toHaveProperty('cuil');
  });

  test('perfil duplicado para el mismo empleado es rechazado', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const emp = await createEmployee(orgId, user._id);
    await createProfile(orgId, emp._id, user._id);

    const res = await request(app).post('/api/payroll/employee-profiles').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, cuil: '20111111110', hireDate: '2020-01-01', baseSalary: 50000 });
    expect(res.status).toBe(409);
  });
});

describe('payroll — PayrollLiquidation borrador', () => {
  async function setupFull() {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    await createPayrollSetting(orgId, user._id);
    const emp = await createEmployee(orgId, user._id);
    await createProfile(orgId, emp._id, user._id);
    await createRuleVersion();
    return { token, orgId, user, emp };
  }

  test('admin crea borrador de liquidación exitosamente', async () => {
    const { token, emp } = await setupFull();
    const res = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06', liquidationType: 'monthly' });
    expect(res.status).toBe(201);
    expect(res.body.data.liquidation.status).toBe('draft');
    expect(res.body.data.liquidation.period).toBe('2025-06');
  });

  test('duplicado del mismo tipo/período es bloqueado', async () => {
    const { token, emp } = await setupFull();
    await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06', liquidationType: 'monthly' });

    const res = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06', liquidationType: 'monthly' });
    expect(res.status).toBe(409);
  });

  test('se pueden crear liquidaciones de tipos distintos para el mismo período', async () => {
    const { token, emp } = await setupFull();
    await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06', liquidationType: 'monthly' });

    const res = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06', liquidationType: 'sac_first' });
    expect(res.status).toBe(201);
  });
});

describe('payroll — ítems de liquidación', () => {
  test('no se pueden agregar ítems a liquidación aprobada', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    const emp = await createEmployee(orgId, user._id);
    const liq = await PayrollLiquidation.create({
      organization: orgId, employee: emp._id, period: '2025-06',
      liquidationType: 'monthly', status: 'approved', createdBy: user._id,
    });

    const res = await request(app).post(`/api/payroll/liquidations/${liq._id}/items`).set('Authorization', `Bearer ${token}`)
      .send({ code: 'TEST', label: 'Test', type: 'remunerative', amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/aprobada|pagada|cancelada/i);
  });

  test('agregar ítem manual recalcula totales', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    await createPayrollSetting(orgId, user._id);
    const emp = await createEmployee(orgId, user._id);
    await createProfile(orgId, emp._id, user._id);
    await createRuleVersion();

    const createRes = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06' });
    const liqId = createRes.body.data.liquidation._id;

    const res = await request(app).post(`/api/payroll/liquidations/${liqId}/items`).set('Authorization', `Bearer ${token}`)
      .send({ code: 'BASICO', label: 'Sueldo básico', type: 'remunerative', amount: 100000 });
    expect(res.status).toBe(200);
    expect(res.body.data.liquidation.grossRemunerative).toBe(100000);
    expect(res.body.data.liquidation.netPay).toBe(100000);
  });
});

describe('payroll — cálculo', () => {
  test('cálculo interno genera snapshot con ruleVersion', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    await createPayrollSetting(orgId, user._id);
    const emp = await createEmployee(orgId, user._id);
    await createProfile(orgId, emp._id, user._id);
    await createRuleVersion({ version: 'AR-TEST-01', effectiveFrom: new Date('2024-01-01') });

    const createRes = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06' });
    const liqId = createRes.body.data.liquidation._id;

    const calcRes = await request(app).post(`/api/payroll/liquidations/${liqId}/calculate`).set('Authorization', `Bearer ${token}`)
      .send({ calculationProvider: 'internal' });
    expect(calcRes.status).toBe(200);
    expect(calcRes.body.data.liquidation.status).toBe('calculated');
    expect(calcRes.body.data.liquidation.ruleVersion).toBe('AR-TEST-01');
    expect(calcRes.body.data.liquidation.itemsSnapshot.length).toBeGreaterThan(0);
  });

  test('snapshot no cambia si se actualiza la versión de reglas después del cálculo', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    await createPayrollSetting(orgId, user._id);
    const emp = await createEmployee(orgId, user._id);
    await createProfile(orgId, emp._id, user._id);
    await createRuleVersion({ version: 'AR-TEST-01', effectiveFrom: new Date('2024-01-01') });

    const createRes = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06' });
    const liqId = createRes.body.data.liquidation._id;

    await request(app).post(`/api/payroll/liquidations/${liqId}/calculate`).set('Authorization', `Bearer ${token}`)
      .send({ calculationProvider: 'internal' });

    // Simular actualización de reglas (nueva versión)
    await PayrollRuleVersion.create({
      version: 'AR-TEST-02', country: 'AR', effectiveFrom: new Date('2025-01-01'),
      rules: new Map([['jubilacion_empleado', 0.99]]), source: 'Test updated',
    });

    // El snapshot de la liquidación debe seguir teniendo la versión original
    const liq = await PayrollLiquidation.findById(liqId);
    expect(liq.ruleVersion).toBe('AR-TEST-01');
    const jubItem = liq.itemsSnapshot.find(i => i.code === 'AP_JUBILACION');
    // jubilacion calculada con AR-TEST-01 (11%), no con AR-TEST-02 (99%)
    if (jubItem) expect(jubItem.amount).toBeLessThan(liq.grossRemunerative * 0.5);
  });

  test('no se puede recalcular una liquidación aprobada', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    const emp = await createEmployee(orgId, user._id);
    const liq = await PayrollLiquidation.create({
      organization: orgId, employee: emp._id, period: '2025-06',
      liquidationType: 'monthly', status: 'approved', createdBy: user._id,
    });

    const res = await request(app).post(`/api/payroll/liquidations/${liq._id}/calculate`).set('Authorization', `Bearer ${token}`)
      .send({ calculationProvider: 'internal' });
    expect(res.status).toBe(400);
  });
});

describe('payroll — aprobación y Expense', () => {
  async function setupCalculated() {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    await createPayrollSetting(orgId, user._id);
    const emp = await createEmployee(orgId, user._id);
    await createProfile(orgId, emp._id, user._id);
    await createRuleVersion({ version: 'AR-TEST-01', effectiveFrom: new Date('2024-01-01') });

    const createRes = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06' });
    const liqId = createRes.body.data.liquidation._id;
    await request(app).post(`/api/payroll/liquidations/${liqId}/calculate`).set('Authorization', `Bearer ${token}`)
      .send({ calculationProvider: 'internal' });

    return { token, orgId, user, emp, liqId };
  }

  test('aprobación genera Expense exactamente una vez', async () => {
    const { token, orgId, liqId } = await setupCalculated();

    const res = await request(app).post(`/api/payroll/liquidations/${liqId}/approve`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.liquidation.status).toBe('approved');
    expect(res.body.data.liquidation.expenseId).toBeTruthy();

    const expenseCount = await Expense.countDocuments({ organization: orgId, category: 'salaries' });
    expect(expenseCount).toBe(1);
  });

  test('reintento de aprobación no duplica Expense', async () => {
    const { token, orgId, liqId } = await setupCalculated();

    await request(app).post(`/api/payroll/liquidations/${liqId}/approve`).set('Authorization', `Bearer ${token}`);
    // Volver a estado calculated manualmente para testear reintento
    await PayrollLiquidation.findByIdAndUpdate(liqId, { status: 'calculated' });

    await request(app).post(`/api/payroll/liquidations/${liqId}/approve`).set('Authorization', `Bearer ${token}`);
    const expenseCount = await Expense.countDocuments({ organization: orgId, category: 'salaries' });
    expect(expenseCount).toBe(1);
  });

  test('Salary existente con Expense dispara advertencia DUPLICATE_EXPENSE_WARNING', async () => {
    const { token, orgId, user, emp, liqId } = await setupCalculated();

    // Crear Salary con Expense para el mismo período/empleado
    const existingExpense = await Expense.create({ organization: orgId, description: 'Sueldo prev', category: 'salaries', amount: 50000, date: new Date('2025-06-01'), status: 'pending', createdBy: user._id });
    await Salary.create({ organization: orgId, employee: emp._id, period: '2025-06', baseAmount: 50000, extraAmount: 0, deductions: 0, totalAmount: 50000, paidAmount: 0, remainingAmount: 50000, status: 'pending', expenseId: existingExpense._id, createdBy: user._id });

    const res = await request(app).post(`/api/payroll/liquidations/${liqId}/approve`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_EXPENSE_WARNING');
  });
});

describe('payroll — baja de empleado ampliada', () => {
  test('baja bloqueada por PayrollLiquidation pendiente', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const emp = await createEmployee(orgId, user._id);
    await PayrollLiquidation.create({ organization: orgId, employee: emp._id, period: '2025-06', liquidationType: 'monthly', status: 'draft', createdBy: user._id });

    const res = await request(app).delete(`/api/employees/${emp._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/liquidaciones de haberes/i);
  });

  test('baja permitida si todas las liquidaciones están pagadas o canceladas', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const emp = await createEmployee(orgId, user._id);
    await PayrollLiquidation.create({ organization: orgId, employee: emp._id, period: '2025-06', liquidationType: 'monthly', status: 'paid', createdBy: user._id });

    const res = await request(app).delete(`/api/employees/${emp._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('payroll — adelantos importados', () => {
  test('importar adelantos los agrega como ítems de deducción', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    await enableLegalPayroll(orgId);
    await createPayrollSetting(orgId, user._id);
    const emp = await createEmployee(orgId, user._id);
    await createProfile(orgId, emp._id, user._id);

    // Crear un Salary y SalaryPayment de tipo advance
    const sal = await Salary.create({ organization: orgId, employee: emp._id, period: '2025-06', baseAmount: 100000, extraAmount: 0, deductions: 0, totalAmount: 100000, paidAmount: 0, remainingAmount: 100000, status: 'pending', createdBy: user._id });
    const advance = await SalaryPayment.create({ organization: orgId, salary: sal._id, employee: emp._id, period: '2025-06', type: 'advance', amount: 20000, paymentMethod: 'transfer', isActive: true, createdBy: user._id });

    // Crear borrador
    const createRes = await request(app).post('/api/payroll/liquidations').set('Authorization', `Bearer ${token}`)
      .send({ employeeId: emp._id, period: '2025-06' });
    expect(createRes.body.data.suggestedDeductions).toHaveLength(1);
    const liqId = createRes.body.data.liquidation._id;

    // Importar adelanto
    const res = await request(app).post(`/api/payroll/liquidations/${liqId}/import-advances`).set('Authorization', `Bearer ${token}`)
      .send({ salaryPaymentIds: [advance._id] });
    expect(res.status).toBe(200);
    expect(res.body.data.importedCount).toBe(1);
    const dedItems = res.body.data.liquidation.itemsSnapshot.filter(i => i.code === 'ADELANTO');
    expect(dedItems).toHaveLength(1);
    expect(dedItems[0].type).toBe('deduction');
    expect(dedItems[0].amount).toBe(20000);
  });
});

describe('payroll — PayrollRuleVersion selección por fecha', () => {
  test('cálculo para período 2025-06 usa versión vigente más reciente', async () => {
    await createRuleVersion({ version: 'AR-2024-01', effectiveFrom: new Date('2024-01-01') });
    await createRuleVersion({ version: 'AR-2025-01', effectiveFrom: new Date('2025-01-01') });
    await createRuleVersion({ version: 'AR-2026-01', effectiveFrom: new Date('2026-01-01') });

    const { getActiveRuleVersion } = require('../src/services/payrollCalculationService');
    const v = await getActiveRuleVersion('2025-06');
    expect(v.version).toBe('AR-2025-01');
  });
});

describe('payroll — recibo PDF', () => {
  test('PDF no accesible a owners', async () => {
    const { token, orgId } = await createOwnerWithToken();
    const res = await request(app).post(`/api/payroll/liquidations/000000000000/receipt-pdf`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('PDF no accesible a security_guard', async () => {
    const { orgId } = await createAdminWithToken();
    const { token } = await createSecurityGuardToken(orgId);
    const res = await request(app).post(`/api/payroll/liquidations/000000000000/receipt-pdf`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
