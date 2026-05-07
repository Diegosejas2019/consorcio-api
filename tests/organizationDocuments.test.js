jest.mock('../src/config/cloudinary', () => {
  const multer = require('multer');
  const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  const fileFilter = (req, file, cb) => {
    if (allowed.has(file.mimetype)) return cb(null, true);
    const err = new Error('Solo se permiten PDF o imagenes JPG, PNG o WebP.');
    err.statusCode = 400;
    return cb(err, false);
  };
  const memoryUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 },
  });
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
      utils:    { private_download_url: jest.fn().mockReturnValue('https://signed.example.com/documento.pdf') },
    },
  };
});

const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createAdminWithToken, createOwnerWithToken } = require('./helpers/factories');
const OrganizationDocument = require('../src/models/OrganizationDocument');
const OrganizationFeature = require('../src/models/OrganizationFeature');
const { cloudinary } = require('../src/config/cloudinary');

const FAKE_PDF = Buffer.from('%PDF-1.4 fake document');
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const originalFetch = global.fetch;

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(async () => {
  jest.clearAllMocks();
  global.fetch = originalFetch;
  await dbHelper.clear();
});

describe('Organization documents', () => {
  test('admin crea un documento PDF visible para propietarios', async () => {
    const { token, orgId, user } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/organization-documents')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'Reglamento de copropiedad')
      .field('description', 'Documento principal')
      .field('category', 'regulation')
      .field('visibility', 'owners')
      .attach('file', FAKE_PDF, { filename: 'reglamento.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.document.organization).toBe(orgId.toString());
    expect(res.body.data.document.uploadedBy).toBe(user._id.toString());
    expect(res.body.data.document.file.filename).toBe('reglamento.pdf');
    expect(res.body.data.document.file.mimetype).toBe('application/pdf');
    expect(res.body.data.document.categoryLabel).toBe('Reglamento');
  });

  test('admin crea una imagen visible solo para administradores', async () => {
    const { token } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/organization-documents')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'Mapa interno')
      .field('category', 'map')
      .field('visibility', 'admin')
      .attach('file', FAKE_PNG, { filename: 'mapa.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.data.document.visibility).toBe('admin');
    expect(res.body.data.document.fileTypeLabel).toBe('Imagen');
  });

  test('owner lista solo documentos visibles para propietarios', async () => {
    const { user: owner, token, orgId } = await createOwnerWithToken();
    const { user: admin } = await createAdminWithToken(orgId);

    await OrganizationDocument.create([
      {
        organization: orgId,
        title: 'Normas de convivencia',
        category: 'rules',
        visibility: 'owners',
        uploadedBy: admin._id,
        file: { publicId: 'owners_doc', filename: 'normas.pdf', mimetype: 'application/pdf', size: 10 },
      },
      {
        organization: orgId,
        title: 'Contrato interno',
        category: 'contract',
        visibility: 'admin',
        uploadedBy: admin._id,
        file: { publicId: 'admin_doc', filename: 'contrato.pdf', mimetype: 'application/pdf', size: 10 },
      },
    ]);

    const res = await request(app)
      .get('/api/organization-documents?visibility=admin')
      .set('Authorization', `Bearer ${token}`);

    expect(owner.role).toBe('owner');
    expect(res.status).toBe(200);
    expect(res.body.data.documents).toHaveLength(1);
    expect(res.body.data.documents[0].title).toBe('Normas de convivencia');
  });

  test('owner no accede por URL directa a un documento admin', async () => {
    const { token, orgId } = await createOwnerWithToken();
    const { user: admin } = await createAdminWithToken(orgId);
    const document = await OrganizationDocument.create({
      organization: orgId,
      title: 'Poliza interna',
      visibility: 'admin',
      uploadedBy: admin._id,
      file: { publicId: 'admin_only', filename: 'poliza.pdf', mimetype: 'application/pdf', size: 10 },
    });

    const res = await request(app)
      .get(`/api/organization-documents/${document._id}/download`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test('admin edita titulo, categoria y visibilidad', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const document = await OrganizationDocument.create({
      organization: orgId,
      title: 'Acta borrador',
      category: 'other',
      visibility: 'admin',
      uploadedBy: user._id,
      file: { publicId: 'acta', filename: 'acta.pdf', mimetype: 'application/pdf', size: 10 },
    });

    const res = await request(app)
      .patch(`/api/organization-documents/${document._id}`)
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'Acta de asamblea')
      .field('category', 'assembly')
      .field('visibility', 'owners');

    expect(res.status).toBe(200);
    expect(res.body.data.document.title).toBe('Acta de asamblea');
    expect(res.body.data.document.category).toBe('assembly');
    expect(res.body.data.document.visibility).toBe('owners');
    expect(res.body.data.document.updatedBy).toBe(user._id.toString());
  });

  test('admin reemplaza archivo y elimina el anterior de Cloudinary', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const document = await OrganizationDocument.create({
      organization: orgId,
      title: 'Instructivo de pago',
      uploadedBy: user._id,
      file: { publicId: 'old_file', filename: 'viejo.pdf', mimetype: 'application/pdf', size: 10 },
    });

    const res = await request(app)
      .patch(`/api/organization-documents/${document._id}`)
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'Instructivo actualizado')
      .attach('file', FAKE_PDF, { filename: 'nuevo.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.data.document.file.filename).toBe('nuevo.pdf');
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('old_file', { resource_type: 'raw' });
  });

  test('admin elimina documento con soft delete', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const document = await OrganizationDocument.create({
      organization: orgId,
      title: 'Documento a eliminar',
      uploadedBy: user._id,
      file: { publicId: 'delete_me', filename: 'doc.pdf', mimetype: 'application/pdf', size: 10 },
    });

    const deleted = await request(app)
      .delete(`/api/organization-documents/${document._id}`)
      .set('Authorization', `Bearer ${token}`);

    const list = await request(app)
      .get('/api/organization-documents')
      .set('Authorization', `Bearer ${token}`);

    const stored = await OrganizationDocument.findById(document._id);
    expect(deleted.status).toBe(200);
    expect(stored.isActive).toBe(false);
    expect(list.body.data.documents).toHaveLength(0);
    expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
  });

  test('admin filtra por categoria, visibilidad y busqueda', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    await OrganizationDocument.create([
      {
        organization: orgId,
        title: 'Mapa del barrio',
        description: 'Plano completo',
        category: 'map',
        visibility: 'owners',
        uploadedBy: user._id,
      },
      {
        organization: orgId,
        title: 'Contrato mantenimiento',
        description: 'Proveedor principal',
        category: 'contract',
        visibility: 'admin',
        uploadedBy: user._id,
      },
    ]);

    const res = await request(app)
      .get('/api/organization-documents?category=contract&visibility=admin&search=mantenimiento')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.documents).toHaveLength(1);
    expect(res.body.data.documents[0].title).toBe('Contrato mantenimiento');
  });

  test('archivo invalido devuelve error en espanol', async () => {
    const { token } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/organization-documents')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'Archivo invalido')
      .attach('file', Buffer.from('hola'), { filename: 'doc.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Solo se permiten');
  });

  test('archivo mayor a 10 MB devuelve error en espanol', async () => {
    const { token } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/organization-documents')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'Archivo pesado')
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'grande.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('10 MB');
  });

  test('no permite acceder a documentos de otra organizacion', async () => {
    const orgA = await createAdminWithToken();
    const orgB = await createAdminWithToken();
    const document = await OrganizationDocument.create({
      organization: orgA.orgId,
      title: 'Documento de otra organizacion',
      uploadedBy: orgA.user._id,
      file: { publicId: 'cross_tenant', filename: 'doc.pdf', mimetype: 'application/pdf', size: 10 },
    });

    const res = await request(app)
      .get(`/api/organization-documents/${document._id}`)
      .set('Authorization', `Bearer ${orgB.token}`);

    expect(res.status).toBe(404);
  });

  test('admin descarga documento mediante proxy seguro', async () => {
    const { token, orgId, user } = await createAdminWithToken();
    const document = await OrganizationDocument.create({
      organization: orgId,
      title: 'Seguro',
      category: 'insurance',
      visibility: 'admin',
      uploadedBy: user._id,
      file: { publicId: 'seguro_doc', filename: 'seguro.pdf', mimetype: 'application/pdf', size: 4 },
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok:      true,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? '4' : null) },
      body:    new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
          controller.close();
        },
      }),
    });

    const res = await request(app)
      .get(`/api/organization-documents/${document._id}/download`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('filename="seguro.pdf"');
    expect(cloudinary.utils.private_download_url).toHaveBeenCalledWith(
      'seguro_doc',
      'pdf',
      expect.objectContaining({ resource_type: 'raw', type: 'upload' })
    );
    expect(global.fetch).toHaveBeenCalledWith('https://signed.example.com/documento.pdf');
  });

  test('bloquea el modulo si la feature documents esta deshabilitada', async () => {
    const { token, orgId } = await createAdminWithToken();
    await OrganizationFeature.findOneAndUpdate(
      { organization: orgId, featureKey: 'documents' },
      { enabled: false },
      { upsert: true, new: true }
    );

    const res = await request(app)
      .get('/api/organization-documents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('documentacion');
  });
});
