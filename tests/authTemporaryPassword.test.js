jest.mock('../src/services/emailService', () => ({
  sendWelcome: jest.fn().mockResolvedValue(null),
  sendEmail: jest.fn().mockResolvedValue(null),
  sendPasswordReset: jest.fn().mockResolvedValue(null),
}));

const request = require('supertest');
const XLSX = require('xlsx');
const app = require('../src/app');
const dbHelper = require('./helpers/dbHelper');
const { createAdminWithToken, createOwnerWithToken } = require('./helpers/factories');
const User = require('../src/models/User');
const OrganizationMember = require('../src/models/OrganizationMember');

beforeAll(() => dbHelper.connect());
afterAll(() => dbHelper.disconnect());
beforeEach(() => {
  delete process.env.BREVO_API_KEY;
});
afterEach(async () => {
  delete process.env.BREVO_API_KEY;
  await dbHelper.clear();
});

describe('contraseña temporal obligatoria', () => {
  test('crear propietario individual marca mustChangePassword', async () => {
    const { token } = await createAdminWithToken();

    const res = await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Owner Temporal',
        email: 'owner-temporal@test.com',
        password: 'Temp1234',
      });

    expect(res.status).toBe(201);
    const user = await User.findOne({ email: 'owner-temporal@test.com' });
    expect(user.mustChangePassword).toBe(true);
    expect(user.temporaryPasswordCreatedAt).toBeTruthy();
  });

  test('carga masiva marca mustChangePassword para propietarios nuevos', async () => {
    const { token } = await createAdminWithToken();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
      { nombre: 'Owner Bulk', email: 'owner-bulk@test.com', contraseña: 'Temp1234' },
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Propietarios');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const res = await request(app)
      .post('/api/owners/bulk')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, {
        filename: 'owners.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

    expect(res.status).toBe(201);
    const user = await User.findOne({ email: 'owner-bulk@test.com' });
    expect(user.mustChangePassword).toBe(true);
    expect(user.temporaryPasswordCreatedAt).toBeTruthy();
  });

  test('login con contraseña temporal bloquea endpoints normales hasta cambiarla', async () => {
    const { token, orgId } = await createAdminWithToken();
    await request(app)
      .post('/api/owners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Owner Primer Ingreso',
        email: 'primer-ingreso@test.com',
        password: 'Temp1234',
      });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'primer-ingreso@test.com', password: 'Temp1234' });

    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);
    expect(login.body.token).toBeTruthy();

    const blocked = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.mustChangePassword).toBe(true);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.mustChangePassword).toBe(true);

    const wrongCurrent = await request(app)
      .post('/api/auth/change-temporary-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: 'OtraClave', newPassword: 'Nueva123', confirmPassword: 'Nueva123' });
    expect(wrongCurrent.status).toBe(401);

    const mismatch = await request(app)
      .post('/api/auth/change-temporary-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: 'Temp1234', newPassword: 'Nueva123', confirmPassword: 'Nueva456' });
    expect(mismatch.status).toBe(400);

    const same = await request(app)
      .post('/api/auth/change-temporary-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: 'Temp1234', newPassword: 'Temp1234', confirmPassword: 'Temp1234' });
    expect(same.status).toBe(400);

    const changed = await request(app)
      .post('/api/auth/change-temporary-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: 'Temp1234', newPassword: 'Nueva123', confirmPassword: 'Nueva123' });
    expect(changed.status).toBe(200);
    expect(changed.body.token).toBeTruthy();

    const user = await User.findOne({ email: 'primer-ingreso@test.com' });
    expect(user.mustChangePassword).toBe(false);
    expect(user.passwordChangedAt).toBeTruthy();

    const allowed = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${changed.body.token}`);
    expect([200, 404]).toContain(allowed.status);

    const membership = await OrganizationMember.findOne({ user: user._id, organization: orgId });
    expect(membership).toBeTruthy();
  });
});

describe('cambio seguro de email', () => {
  test('PATCH /owners/:id no cambia email directo', async () => {
    const { token, orgId } = await createAdminWithToken();
    const owner = await User.create({
      name: 'Owner Email',
      email: 'owner-email@test.com',
      password: 'password123',
      role: 'owner',
      organization: orgId,
      isActive: true,
    });
    await OrganizationMember.create({ user: owner._id, organization: orgId, role: 'owner', isActive: true });

    const res = await request(app)
      .patch(`/api/owners/${owner._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'nuevo-directo@test.com', name: 'Owner Email Editado' });

    expect(res.status).toBe(200);
    const updated = await User.findById(owner._id);
    expect(updated.name).toBe('Owner Email Editado');
    expect(updated.email).toBe('owner-email@test.com');
  });

  test('owner solicita y confirma cambio de email con token', async () => {
    const { user, token } = await createOwnerWithToken({ email: 'owner-cambio@test.com' });

    const requestRes = await request(app)
      .post('/api/owners/me/request-email-change')
      .set('Authorization', `Bearer ${token}`)
      .send({ newEmail: 'owner-nuevo@test.com' });

    expect(requestRes.status).toBe(200);
    expect(requestRes.body.data.token).toBeTruthy();
    const pending = await User.findById(user._id).select('+emailChangeToken');
    expect(pending.pendingEmail).toBe('owner-nuevo@test.com');
    expect(pending.emailChangeToken).toBeTruthy();

    const confirmRes = await request(app)
      .post('/api/owners/me/confirm-email-change')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: requestRes.body.data.token });

    expect(confirmRes.status).toBe(200);
    const updated = await User.findById(user._id).select('+emailChangeToken');
    expect(updated.email).toBe('owner-nuevo@test.com');
    expect(updated.pendingEmail).toBeUndefined();
    expect(updated.emailChangeToken).toBeUndefined();
    expect(updated.emailVerifiedAt).toBeTruthy();
  });

  test('confirmación de email falla con token inválido o email tomado', async () => {
    const { user, token } = await createOwnerWithToken({ email: 'owner-token@test.com' });

    const invalid = await request(app)
      .post('/api/owners/me/confirm-email-change')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: 'invalido' });
    expect(invalid.status).toBe(400);

    const expiredRequest = await request(app)
      .post('/api/owners/me/request-email-change')
      .set('Authorization', `Bearer ${token}`)
      .send({ newEmail: 'expirado@test.com' });
    await User.findByIdAndUpdate(user._id, { emailChangeTokenExpiresAt: new Date(Date.now() - 1000) });
    const expired = await request(app)
      .post('/api/owners/me/confirm-email-change')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: expiredRequest.body.data.token });
    expect(expired.status).toBe(400);

    const requestRes = await request(app)
      .post('/api/owners/me/request-email-change')
      .set('Authorization', `Bearer ${token}`)
      .send({ newEmail: 'ocupado@test.com' });
    expect(requestRes.status).toBe(200);

    await User.create({
      name: 'Otro Owner',
      email: 'ocupado@test.com',
      password: 'password123',
      role: 'owner',
      isActive: true,
    });

    const conflict = await request(app)
      .post('/api/owners/me/confirm-email-change')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: requestRes.body.data.token });

    expect(conflict.status).toBe(400);
    expect(conflict.body.message).toContain('uso');
    const unchanged = await User.findById(user._id);
    expect(unchanged.email).toBe('owner-token@test.com');
  });
});
