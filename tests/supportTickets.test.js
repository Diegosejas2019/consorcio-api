const request = require('supertest');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createOwnerWithToken, createAdminWithToken } = require('./helpers/factories');
const SupportTicket = require('../src/models/SupportTicket');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
afterEach(() => dbHelper.clear());

describe('Support tickets', () => {
  test('owner crea ticket con userId y organizationId del token', async () => {
    const { user, token, orgId } = await createOwnerWithToken();

    const res = await request(app)
      .post('/api/support-tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'bug',
        title: 'Error al pagar',
        description: 'No puedo enviar el comprobante desde la app.',
        organizationId: '000000000000000000000000',
        userId: '000000000000000000000000',
        context: {
          route: '/pagos',
          userAgent: 'jest',
          metadata: {
            timestamp: '2026-04-29T12:00:00.000Z',
            token: 'secreto',
            cardNumber: '4111111111111111',
            safeValue: 'ok',
          },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.ticket.organizationId._id).toBe(orgId.toString());
    expect(res.body.data.ticket.userId._id).toBe(user._id.toString());
    expect(res.body.data.ticket.context.route).toBe('/pagos');
    expect(res.body.data.ticket.context.metadata.safeValue).toBe('ok');
    expect(res.body.data.ticket.context.metadata.token).toBeUndefined();
    expect(res.body.data.ticket.context.metadata.cardNumber).toBeUndefined();
  });

  test('owner no puede listar tickets admin', async () => {
    const { token } = await createOwnerWithToken();

    const res = await request(app)
      .get('/api/support-tickets')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('GET /my devuelve solo tickets propios de la organizacion', async () => {
    const { user, token, orgId } = await createOwnerWithToken();
    const other = await createOwnerWithToken({ email: `other-${Date.now()}@test.com` });

    await SupportTicket.create([
      {
        organizationId: orgId,
        userId: user._id,
        userRole: 'owner',
        type: 'question',
        title: 'Mi consulta',
        description: 'Descripcion valida para el ticket propio.',
      },
      {
        organizationId: other.orgId,
        userId: other.user._id,
        userRole: 'owner',
        type: 'bug',
        title: 'Otro ticket',
        description: 'Descripcion valida para otro ticket.',
      },
    ]);

    const res = await request(app)
      .get('/api/support-tickets/my')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.tickets).toHaveLength(1);
    expect(res.body.data.tickets[0].title).toBe('Mi consulta');
  });

  test('admin ve solo tickets de su organizacion y puede filtrar', async () => {
    const { token, orgId } = await createAdminWithToken();
    const other = await createAdminWithToken();

    await SupportTicket.create([
      {
        organizationId: orgId,
        userId: (await createOwnerWithToken({ email: `a-${Date.now()}@test.com` })).user._id,
        userRole: 'owner',
        type: 'payment_issue',
        title: 'Pago duplicado',
        description: 'Descripcion valida para ticket de pago.',
        priority: 'high',
      },
      {
        organizationId: other.orgId,
        userId: other.user._id,
        userRole: 'admin',
        type: 'bug',
        title: 'No debe verse',
        description: 'Descripcion valida para otro tenant.',
      },
    ]);

    const res = await request(app)
      .get('/api/support-tickets?type=payment_issue&priority=high')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.tickets).toHaveLength(1);
    expect(res.body.data.tickets[0].title).toBe('Pago duplicado');
  });

  test('admin actualiza estado y prioridad dentro de su organizacion', async () => {
    const { user, token, orgId } = await createAdminWithToken();
    const ticket = await SupportTicket.create({
      organizationId: orgId,
      userId: user._id,
      userRole: 'admin',
      type: 'suggestion',
      title: 'Mejora de pantalla',
      description: 'Descripcion valida para una sugerencia.',
    });

    const res = await request(app)
      .patch(`/api/support-tickets/${ticket._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        status: 'resolved',
        priority: 'high',
        adminResponse: 'Gracias, lo revisamos.',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.ticket.status).toBe('resolved');
    expect(res.body.data.ticket.priority).toBe('high');
    expect(res.body.data.ticket.resolvedAt).toBeTruthy();
  });

  test('validacion clara para titulo o descripcion invalidos', async () => {
    const { token } = await createOwnerWithToken();

    const res = await request(app)
      .post('/api/support-tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'bug',
        title: '',
        description: 'corta',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('titulo');
  });
});
