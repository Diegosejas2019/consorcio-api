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

jest.mock('../src/services/firebaseService', () => ({
  sendToUser: jest.fn().mockResolvedValue(null),
  sendMulticast: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/emailService', () => ({
  sendNoticeEmail: jest.fn().mockResolvedValue(null),
  sendMonthlyReminder: jest.fn().mockResolvedValue(null),
}));

const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createAdminWithToken, createOwnerWithToken } = require('./helpers/factories');
const DelinquencyReminder = require('../src/models/DelinquencyReminder');
const Expense = require('../src/models/Expense');
const Notice = require('../src/models/Notice');
const Organization = require('../src/models/Organization');
const OrganizationMember = require('../src/models/OrganizationMember');
const Payment = require('../src/models/Payment');
const Unit = require('../src/models/Unit');
const User = require('../src/models/User');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  delete process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE;
  delete process.env.GESTIONAR_CURRENT_DATE_OVERRIDE;
  await dbHelper.clear();
});

async function createOwnerInOrg(orgId, data = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await User.create({
    name: data.name || 'Owner Mora',
    email: data.email || `owner-mora-${suffix}@test.com`,
    password: 'password123',
    role: 'owner',
    organization: orgId,
    unit: data.legacyUnit,
    isActive: true,
  });
  const membership = await OrganizationMember.create({
    user: user._id,
    organization: orgId,
    role: 'owner',
    isActive: true,
    startBillingPeriod: data.startBillingPeriod,
  });
  const unit = data.unitName ? await Unit.create({
    organization: orgId,
    owner: user._id,
    name: data.unitName,
    coefficient: data.coefficient ?? 1,
    customFee: data.customFee ?? null,
    balance: data.balance ?? 0,
    startBillingPeriod: data.unitStartBillingPeriod,
  }) : null;
  return { user, membership, unit };
}

describe('Morosidad avanzada', () => {
  test('devuelve resumen y ranking ordenado por deuda sin mezclar organizaciones', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-03';
    process.env.GESTIONAR_CURRENT_DATE_OVERRIDE = '2026-03-20T12:00:00.000Z';
    const { token, orgId } = await createAdminWithToken();
    const { orgId: otherOrg } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 1000,
      dueDayOfMonth: 10,
      paymentPeriods: ['2026-01', '2026-02', '2026-03'],
    });
    await Organization.findByIdAndUpdate(otherOrg, {
      monthlyFee: 9999,
      dueDayOfMonth: 10,
      paymentPeriods: ['2026-01', '2026-02', '2026-03'],
    });

    const high = await createOwnerInOrg(orgId, { name: 'Deuda Alta', unitName: 'A-01', startBillingPeriod: '2026-01', balance: -500 });
    const low = await createOwnerInOrg(orgId, { name: 'Deuda Baja', unitName: 'B-01', startBillingPeriod: '2026-01' });
    const foreign = await createOwnerInOrg(otherOrg, { name: 'Otro Tenant', unitName: 'X-01', startBillingPeriod: '2026-01' });
    await Payment.create([
      { organization: orgId, owner: low.user._id, month: '2026-01', amount: 1000, status: 'approved', type: 'monthly' },
      { organization: otherOrg, owner: foreign.user._id, month: '2026-01', amount: 9999, status: 'pending', type: 'monthly' },
    ]);

    const summary = await request(app).get('/api/delinquency/summary').set('Authorization', `Bearer ${token}`);
    expect(summary.status).toBe(200);
    expect(summary.body.data.summary.totalDebt).toBe(5500);
    expect(summary.body.data.summary.delinquentOwners).toBe(2);

    const owners = await request(app).get('/api/delinquency/owners?limit=10').set('Authorization', `Bearer ${token}`);
    expect(owners.status).toBe(200);
    expect(owners.body.data.owners.map(o => o.name)).toEqual(['Deuda Alta', 'Deuda Baja']);
    expect(owners.body.data.owners[0].totalOwed).toBe(3500);
    expect(owners.body.data.owners.some(o => o.name === 'Otro Tenant')).toBe(false);
  });

  test('separa pagos pendientes y rechazados sin descontarlos de la deuda', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-02';
    process.env.GESTIONAR_CURRENT_DATE_OVERRIDE = '2026-02-20T12:00:00.000Z';
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 2000,
      dueDayOfMonth: 10,
      paymentPeriods: ['2026-01', '2026-02'],
    });
    const owner = await createOwnerInOrg(orgId, { name: 'Pagos Pendientes', unitName: 'C-01', startBillingPeriod: '2026-01' });
    await Payment.create([
      { organization: orgId, owner: owner.user._id, month: '2026-01', amount: 2000, status: 'approved', type: 'monthly' },
      { organization: orgId, owner: owner.user._id, month: '2026-02', amount: 2000, status: 'pending', type: 'monthly' },
      { organization: orgId, owner: owner.user._id, month: '2025-12', amount: 2000, status: 'rejected', type: 'monthly' },
    ]);

    const res = await request(app).get(`/api/delinquency/owners/${owner.user._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.detail.summary.totalOwed).toBe(2000);
    expect(res.body.data.detail.payments.pending).toHaveLength(1);
    expect(res.body.data.detail.payments.rejected).toHaveLength(1);
  });

  test('no marca moroso si la unica expensa pendiente todavia no vencio', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-03';
    process.env.GESTIONAR_CURRENT_DATE_OVERRIDE = '2026-03-05T12:00:00.000Z';
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 1500,
      dueDayOfMonth: 10,
      paymentPeriods: ['2026-03'],
    });
    const owner = await createOwnerInOrg(orgId, { name: 'Pendiente No Vencido', unitName: 'NV-01', startBillingPeriod: '2026-03' });

    const detail = await request(app).get(`/api/delinquency/owners/${owner.user._id}`).set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.detail.summary.totalOwed).toBe(1500);
    expect(detail.body.data.detail.summary.overdueOwed).toBe(0);
    expect(detail.body.data.detail.summary.daysOverdue).toBe(0);
    expect(detail.body.data.detail.summary.status).toBe('al_dia');

    const summary = await request(app).get('/api/delinquency/summary').set('Authorization', `Bearer ${token}`);
    expect(summary.status).toBe(200);
    expect(summary.body.data.summary.totalDebt).toBe(0);
    expect(summary.body.data.summary.delinquentOwners).toBe(0);

    const owners = await request(app).get('/api/owners').set('Authorization', `Bearer ${token}`);
    expect(owners.status).toBe(200);
    const gridOwner = owners.body.data.owners.find(o => o._id === owner.user._id.toString());
    expect(gridOwner.totalOwed).toBe(1500);
    expect(gridOwner.overdueOwed).toBe(0);
    expect(gridOwner.daysOverdue).toBe(0);
    expect(gridOwner.isDebtor).toBe(false);
  });

  test('marca moroso cuando la expensa pendiente esta vencida', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-03';
    process.env.GESTIONAR_CURRENT_DATE_OVERRIDE = '2026-03-20T12:00:00.000Z';
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 1500,
      dueDayOfMonth: 10,
      paymentPeriods: ['2026-03'],
    });
    const owner = await createOwnerInOrg(orgId, { name: 'Pendiente Vencido', unitName: 'V-03', startBillingPeriod: '2026-03' });

    const detail = await request(app).get(`/api/delinquency/owners/${owner.user._id}`).set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.detail.summary.totalOwed).toBe(1500);
    expect(detail.body.data.detail.summary.overdueOwed).toBe(1500);
    expect(detail.body.data.detail.summary.daysOverdue).toBeGreaterThan(0);
    expect(detail.body.data.detail.summary.status).not.toBe('al_dia');

    const owners = await request(app).get('/api/owners').set('Authorization', `Bearer ${token}`);
    expect(owners.status).toBe(200);
    const gridOwner = owners.body.data.owners.find(o => o._id === owner.user._id.toString());
    expect(gridOwner.overdueOwed).toBe(1500);
    expect(gridOwner.daysOverdue).toBeGreaterThan(0);
    expect(gridOwner.isDebtor).toBe(true);
  });

  test('respeta startBillingPeriod futuro y calcula aging', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-03';
    process.env.GESTIONAR_CURRENT_DATE_OVERRIDE = '2026-03-20T12:00:00.000Z';
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 1000,
      dueDayOfMonth: 10,
      paymentPeriods: ['2026-01', '2026-02', '2026-03'],
    });
    await createOwnerInOrg(orgId, { name: 'Futuro', unitName: 'F-01', startBillingPeriod: '2026-05', unitStartBillingPeriod: '2026-05' });
    await createOwnerInOrg(orgId, { name: 'Vencido', unitName: 'V-01', startBillingPeriod: '2026-01' });

    const owners = await request(app).get('/api/delinquency/owners?status=al_dia').set('Authorization', `Bearer ${token}`);
    expect(owners.status).toBe(200);
    expect(owners.body.data.owners.map(o => o.name)).toContain('Futuro');

    const aging = await request(app).get('/api/delinquency/aging').set('Authorization', `Bearer ${token}`);
    expect(aging.status).toBe(200);
    expect(aging.body.data.buckets.reduce((sum, b) => sum + b.owners, 0)).toBe(1);
    expect(aging.body.data.buckets.find(b => b.key === '61-90').owners).toBe(1);
  });

  test('recordatorio app crea comunicado interno y log', async () => {
    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-01';
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, {
      monthlyFee: 1000,
      dueDayOfMonth: 10,
      paymentPeriods: ['2026-01'],
    });
    const owner = await createOwnerInOrg(orgId, { name: 'Recordado', unitName: 'R-01', startBillingPeriod: '2026-01' });

    const res = await request(app)
      .post(`/api/delinquency/owners/${owner.user._id}/reminders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'app', message: 'Recordatorio editable' });

    expect(res.status).toBe(201);
    const reminders = await DelinquencyReminder.find({ organization: orgId, owner: owner.user._id });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].channel).toBe('app');
    const notice = await Notice.findById(reminders[0].notice);
    expect(notice.category).toBe('mora');
    expect(notice.targetType).toBe('specific_users');
  });

  test('propietario no puede acceder y export respeta filtros', async () => {
    const { token: ownerToken } = await createOwnerWithToken();
    const forbidden = await request(app).get('/api/delinquency/summary').set('Authorization', `Bearer ${ownerToken}`);
    expect(forbidden.status).toBe(403);

    process.env.GESTIONAR_CURRENT_PERIOD_OVERRIDE = '2026-01';
    const { token, orgId } = await createAdminWithToken();
    await Organization.findByIdAndUpdate(orgId, { monthlyFee: 1000, paymentPeriods: ['2026-01'] });
    await createOwnerInOrg(orgId, { name: 'Exportable', unitName: 'E-01', startBillingPeriod: '2026-01' });

    const csv = await request(app).get('/api/delinquency/export?search=Exportable').set('Authorization', `Bearer ${token}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Exportable');
    expect(csv.text).toContain('Deuda total');
  });
});
