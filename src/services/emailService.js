const nodemailer = require('nodemailer');
const logger     = require('../config/logger');

// ── Crear transporter ─────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── Template base HTML ────────────────────────────────────────
const baseTemplate = (content) => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ConsorcioPro</title>
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #f8f9fb; margin: 0; padding: 0; color: #111827; }
    .wrapper { max-width: 580px; margin: 32px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    .header { background: #1a1a2e; padding: 28px 32px; }
    .header h1 { color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.5px; }
    .header span { color: #a5b4fc; font-size: 13px; }
    .body { padding: 32px; }
    .body p { line-height: 1.7; color: #374151; margin: 0 0 14px; }
    .highlight { background: #eef2ff; border-left: 4px solid #4f46e5; padding: 16px 20px; border-radius: 0 8px 8px 0; margin: 20px 0; }
    .highlight p { margin: 0; color: #3730a3; font-weight: 600; }
    .badge-success { display:inline-block; background:#d1fae5; color:#065f46; padding:6px 14px; border-radius:99px; font-size:13px; font-weight:700; }
    .badge-danger  { display:inline-block; background:#fee2e2; color:#991b1b; padding:6px 14px; border-radius:99px; font-size:13px; font-weight:700; }
    .btn { display:inline-block; background:#4f46e5; color:#fff; padding:13px 28px; border-radius:8px; text-decoration:none; font-weight:700; font-size:15px; margin-top:8px; }
    .footer { background: #f8f9fb; padding: 20px 32px; text-align:center; }
    .footer p { color: #9ca3af; font-size: 12px; margin: 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>🏘️ ConsorcioPro</h1>
      <span>Administración de Barrio Privado</span>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      <p>Este mensaje fue enviado automáticamente. Por favor no respondas este email.</p>
      <p>© 2025 ConsorcioPro — Todos los derechos reservados.</p>
    </div>
  </div>
</body>
</html>`;

// ── Función genérica para enviar email ────────────────────────
const sendEmail = async ({ to, subject, html }) => {
  try {
    const info = await transporter.sendMail({
      from:    process.env.EMAIL_FROM || '"ConsorcioPro" <noreply@consorcio.com>',
      to,
      subject,
      html,
    });
    logger.info(`Email enviado: ${subject} → ${to} [${info.messageId}]`);
    return info;
  } catch (err) {
    logger.error(`Error enviando email a ${to}: ${err.message}`);
    throw err;
  }
};

// ── Templates específicos ─────────────────────────────────────

// Pago aprobado
exports.sendPaymentApproved = async (owner, payment) => {
  const html = baseTemplate(`
    <p>Hola <strong>${owner.name}</strong>,</p>
    <p>Te informamos que tu comprobante de pago fue <span class="badge-success">✓ Aprobado</span></p>
    <div class="highlight">
      <p>Período: ${payment.monthFormatted}</p>
      <p>Importe: $${payment.amount.toLocaleString('es-AR')}</p>
      <p>Fecha de aprobación: ${new Date(payment.reviewedAt).toLocaleDateString('es-AR')}</p>
    </div>
    <p>Tu cuenta ha sido actualizada. Podés verificar tu estado en la aplicación.</p>
    <p>¡Muchas gracias!</p>
  `);
  return sendEmail({
    to:      owner.email,
    subject: `✓ Pago aprobado — ${payment.monthFormatted} | ConsorcioPro`,
    html,
  });
};

// Pago rechazado
exports.sendPaymentRejected = async (owner, payment, reason) => {
  const html = baseTemplate(`
    <p>Hola <strong>${owner.name}</strong>,</p>
    <p>Lamentablemente tu comprobante de pago fue <span class="badge-danger">✕ Rechazado</span></p>
    <div class="highlight">
      <p>Período: ${payment.monthFormatted}</p>
      <p>Motivo: ${reason}</p>
    </div>
    <p>Por favor revisá el comprobante y volvé a enviarlo desde la aplicación corrigiendo el inconveniente indicado.</p>
    <p>Si tenés dudas, contactá al administrador.</p>
  `);
  return sendEmail({
    to:      owner.email,
    subject: `Comprobante rechazado — ${payment.monthFormatted} | ConsorcioPro`,
    html,
  });
};

// Bienvenida a nuevo propietario
exports.sendWelcome = async (owner, tempPassword) => {
  const html = baseTemplate(`
    <p>Hola <strong>${owner.name}</strong>,</p>
    <p>¡Bienvenido/a a ConsorcioPro! Tu cuenta ha sido creada correctamente.</p>
    <div class="highlight">
      <p>Email: ${owner.email}</p>
      <p>Contraseña temporal: <strong>${tempPassword}</strong></p>
      <p>Unidad: ${owner.unit || '—'}</p>
    </div>
    <p>Te recomendamos cambiar tu contraseña al ingresar por primera vez.</p>
    <a href="${process.env.APP_BASE_URL}" class="btn">Ingresar a ConsorcioPro</a>
    <p style="margin-top:20px">Si tenés problemas para ingresar, contactá al administrador.</p>
  `);
  return sendEmail({
    to:      owner.email,
    subject: '¡Bienvenido/a a ConsorcioPro! Tu acceso está listo.',
    html,
  });
};

// Reset de contraseña
exports.sendPasswordReset = async (user, resetUrl) => {
  const html = baseTemplate(`
    <p>Hola <strong>${user.name}</strong>,</p>
    <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta.</p>
    <p>Hacé clic en el botón para crear una nueva contraseña. Este enlace es válido por <strong>10 minutos</strong>.</p>
    <a href="${resetUrl}" class="btn">Restablecer contraseña</a>
    <p style="margin-top:20px; font-size:13px; color:#6b7280;">Si no solicitaste este cambio, podés ignorar este email. Tu contraseña no será modificada.</p>
    <p style="font-size:12px; color:#9ca3af; word-break:break-all;">Si el botón no funciona, copiá este enlace en tu navegador:<br>${resetUrl}</p>
  `);
  return sendEmail({
    to:      user.email,
    subject: 'Restablecé tu contraseña — ConsorcioPro',
    html,
  });
};

// Recordatorio de vencimiento mensual
exports.sendMonthlyReminder = async (owner, expenseMonth, amount, dueDay) => {
  const html = baseTemplate(`
    <p>Hola <strong>${owner.name}</strong>,</p>
    <p>Te recordamos que las expensas del período <strong>${expenseMonth}</strong> vencen el día <strong>${dueDay}</strong>.</p>
    <div class="highlight">
      <p>Período: ${expenseMonth}</p>
      <p>Importe: $${amount.toLocaleString('es-AR')}</p>
      <p>Vencimiento: día ${dueDay} del mes en curso</p>
    </div>
    <p>Podés abonar fácilmente desde la aplicación subiendo tu comprobante o pagando online con MercadoPago.</p>
    <a href="${process.env.APP_BASE_URL}" class="btn">Pagar ahora</a>
  `);
  return sendEmail({
    to:      owner.email,
    subject: `Recordatorio: Expensas ${expenseMonth} vencen el día ${dueDay}`,
    html,
  });
};

module.exports = { ...exports, sendEmail };
