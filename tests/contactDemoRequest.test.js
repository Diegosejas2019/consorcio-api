const request = require('supertest');

jest.mock('../src/services/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue({ messageId: 'test-message-id' }),
}));

const app = require('../src/app');
const emailService = require('../src/services/emailService');

const validPayload = {
  name: 'Diego Sejas',
  administration: 'Administración Norte',
  email: 'diego@example.com',
  phone: '+54 11 5579-3722',
  consortiaRange: '4 - 10',
  unitsRange: '200 - 600',
  message: 'Quiero ver una demo para mi administración.',
};

describe('POST /api/contact/demo-request', () => {
  beforeEach(() => {
    emailService.sendEmail.mockClear();
    process.env.CONTACT_REQUEST_TO = 'ventas@test.com';
    process.env.SUPPORT_EMAIL = 'soporte@test.com';
  });

  test('envía una solicitud de demo por email', async () => {
    const res = await request(app)
      .post('/api/contact/demo-request')
      .set('X-Forwarded-For', '203.0.113.10')
      .send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Recibimos tu solicitud. Te contactamos en menos de 48 h hábiles.',
    });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'ventas@test.com',
      subject: 'Nueva solicitud de demo - Administración Norte',
      replyTo: { email: 'diego@example.com', name: 'Diego Sejas' },
    }));
  });

  test('valida campos requeridos y email inválido', async () => {
    const res = await request(app)
      .post('/api/contact/demo-request')
      .set('X-Forwarded-For', '203.0.113.11')
      .send({
        ...validPayload,
        name: '',
        email: 'no-es-email',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Ingresá tu nombre');
    expect(res.body.message).toContain('Ingresá un email válido');
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('honeypot responde éxito sin enviar email', async () => {
    const res = await request(app)
      .post('/api/contact/demo-request')
      .set('X-Forwarded-For', '203.0.113.12')
      .send({ website: 'https://spam.example' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('limita a 5 solicitudes por hora por IP', async () => {
    const agentIp = '203.0.113.13';

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post('/api/contact/demo-request')
        .set('X-Forwarded-For', agentIp)
        .send({ ...validPayload, email: `persona${i}@example.com` });

      expect(res.status).toBe(200);
    }

    const limited = await request(app)
      .post('/api/contact/demo-request')
      .set('X-Forwarded-For', agentIp)
      .send({ ...validPayload, email: 'limite@example.com' });

    expect(limited.status).toBe(429);
    expect(limited.body.message).toBe('Demasiadas solicitudes. Intentá de nuevo en 1 hora.');
  });
});
