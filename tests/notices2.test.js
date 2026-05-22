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
    cloudinary: {
      uploader: { destroy: jest.fn().mockResolvedValue({}) },
      utils: { private_download_url: jest.fn().mockReturnValue('https://signed.example.com/adjunto.pdf') },
    },
  };
});

jest.mock('../src/services/firebaseService', () => ({
  sendMulticast: jest.fn().mockResolvedValue([{ successCount: 1, failureCount: 0 }]),
  sendToUser: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../src/services/emailService', () => ({
  sendNoticeEmail: jest.fn().mockResolvedValue({ success: true }),
}));

const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createAdminWithToken, createOwnerWithToken } = require('./helpers/factories');
const Organization = require('../src/models/Organization');
const OrganizationMember = require('../src/models/OrganizationMember');
const User = require('../src/models/User');
const Unit = require('../src/models/Unit');
const Notice = require('../src/models/Notice');
const NoticeReadReceipt = require('../src/models/NoticeReadReceipt');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

async function createMemberOwner(orgId, overrides = {}) {
  const user = await User.create({
    name: overrides.name || `Owner ${Date.now()}`,
    email: overrides.email || `owner-${Date.now()}-${Math.random()}@test.com`,
    password: 'password123',
    role: 'owner',
    organization: orgId,
    isActive: true,
  });
  await OrganizationMember.create({
    user: user._id,
    organization: orgId,
    role: 'owner',
    isActive: true,
    isDebtor: !!overrides.isDebtor,
  });
  const unit = await Unit.create({
    organization: orgId,
    owner: user._id,
    name: overrides.unitName || `Lote ${Math.floor(Math.random() * 10000)}`,
    active: true,
    isDebtor: !!overrides.isDebtor,
    balance: overrides.isDebtor ? -100 : 0,
  });
  return { user, unit };
}

describe('Comunicados 2.0', () => {
  test('admin crea, edita y elimina plantilla por organizacion', async () => {
    const { token } = await createAdminWithToken();

    const created = await request(app)
      .post('/api/notice-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Corte de agua', subject: 'Aviso de corte', body: 'Habra corte programado.', category: 'corte_servicio' });

    expect(created.status).toBe(201);
    expect(created.body.data.template.category).toBe('corte_servicio');

    const id = created.body.data.template._id;
    const updated = await request(app)
      .patch(`/api/notice-templates/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Corte reprogramado' });

    expect(updated.status).toBe(200);
    expect(updated.body.data.template.title).toBe('Corte reprogramado');

    const deleted = await request(app)
      .delete(`/api/notice-templates/${id}`)
      .set('Authorization', `Bearer ${token}`);
    const list = await request(app).get('/api/notice-templates').set('Authorization', `Bearer ${token}`);

    expect(deleted.status).toBe(200);
    expect(list.body.data.templates).toHaveLength(0);
  });

  test('admin crea borrador y owner no lo ve', async () => {
    const { token, orgId } = await createAdminWithToken();
    const { user: owner } = await createMemberOwner(orgId);
    const ownerToken = require('../src/middleware/auth').signToken(owner._id);

    const created = await request(app)
      .post('/api/notices')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Borrador', body: 'Texto interno', action: 'draft' });

    const ownerList = await request(app).get('/api/notices').set('Authorization', `Bearer ${ownerToken}`);

    expect(created.status).toBe(201);
    expect(created.body.data.notice.status).toBe('draft');
    expect(ownerList.body.data.notices).toHaveLength(0);
  });

  test('admin envia comunicado a todos y owner lo marca como leido', async () => {
    const { token, orgId } = await createAdminWithToken();
    const { user: owner } = await createMemberOwner(orgId);
    const ownerToken = require('../src/middleware/auth').signToken(owner._id);

    const created = await request(app)
      .post('/api/notices')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Asamblea', subject: 'Convocatoria', body: 'Reunion general', targetType: 'all', channels: { app: true } });

    const list = await request(app).get('/api/notices').set('Authorization', `Bearer ${ownerToken}`);
    const read = await request(app).patch(`/api/notices/${created.body.data.notice._id}/read`).set('Authorization', `Bearer ${ownerToken}`);
    const stats = await request(app).get(`/api/notices/${created.body.data.notice._id}/stats`).set('Authorization', `Bearer ${token}`);

    expect(created.status).toBe(201);
    expect(created.body.data.notice.status).toBe('sent');
    expect(list.body.data.notices).toHaveLength(1);
    expect(read.status).toBe(200);
    expect(await NoticeReadReceipt.countDocuments()).toBe(1);
    expect(stats.body.data.stats.readCount).toBe(1);
    expect(stats.body.data.stats.totalRecipients).toBe(1);
  });

  test('programa, procesa y cancela comunicados', async () => {
    const { token, orgId } = await createAdminWithToken();
    await createMemberOwner(orgId);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const scheduled = await request(app)
      .post('/api/notices')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Programado', body: 'Sale despues', action: 'schedule', scheduledAt: future });

    expect(scheduled.status).toBe(201);
    expect(scheduled.body.data.notice.status).toBe('scheduled');

    const cancel = await request(app)
      .post(`/api/notices/${scheduled.body.data.notice._id}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(cancel.body.data.notice.status).toBe('cancelled');

    const due = await Notice.create({
      organization: orgId,
      author: scheduled.body.data.notice.author._id || scheduled.body.data.notice.author,
      title: 'Vencido',
      body: 'Ya debe enviarse',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 60 * 1000),
    });

    const processed = await request(app).post('/api/notices/process-scheduled').set('Authorization', `Bearer ${token}`);
    const stored = await Notice.findById(due._id);
    expect(processed.body.data.processed).toBe(1);
    expect(stored.status).toBe('sent');
  });

  test('segmenta por unidad, morosos y no mezcla organizaciones', async () => {
    const orgA = await createAdminWithToken();
    const orgB = await createAdminWithToken();
    const ownerA = await createMemberOwner(orgA.orgId, { unitName: 'A1', isDebtor: true });
    const ownerB = await createMemberOwner(orgA.orgId, { unitName: 'A2' });
    const otherOrgOwner = await createMemberOwner(orgB.orgId, { unitName: 'B1', isDebtor: true });
    const ownerAToken = require('../src/middleware/auth').signToken(ownerA.user._id);
    const ownerBToken = require('../src/middleware/auth').signToken(ownerB.user._id);
    const otherToken = require('../src/middleware/auth').signToken(otherOrgOwner.user._id);

    await request(app)
      .post('/api/notices')
      .set('Authorization', `Bearer ${orgA.token}`)
      .send({ title: 'Unidad A1', body: 'Solo A1', targetType: 'specific_units', targetFilters: { unitIds: [ownerA.unit._id] } });

    await request(app)
      .post('/api/notices')
      .set('Authorization', `Bearer ${orgA.token}`)
      .send({ title: 'Morosos', body: 'Solo morosos', targetType: 'debtors' });

    const listA = await request(app).get('/api/notices').set('Authorization', `Bearer ${ownerAToken}`);
    const listB = await request(app).get('/api/notices').set('Authorization', `Bearer ${ownerBToken}`);
    const listOther = await request(app).get('/api/notices').set('Authorization', `Bearer ${otherToken}`);

    expect(listA.body.data.notices.map(n => n.title).sort()).toEqual(['Morosos', 'Unidad A1']);
    expect(listB.body.data.notices).toHaveLength(0);
    expect(listOther.body.data.notices).toHaveLength(0);
  });

  test('datos legacy sin status se devuelven como enviados', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    await Notice.collection.insertOne({
      title: 'Legacy',
      body: 'Aviso viejo',
      tag: 'warning',
      organization: orgId,
      author: user._id,
      readBy: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app).get('/api/notices').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.notices[0].status).toBe('sent');
    expect(res.body.data.notices[0].category).toBe('general');
    expect(res.body.data.notices[0].priority).toBe('high');
  });
});
