const nodemailer = require('nodemailer');
const logger     = require('../config/logger');

// ── Configuración SMTP ────────────────────────────────────────
const SMTP_HOST            = process.env.SMTP_HOST;
const SMTP_PORT            = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE          = process.env.SMTP_PORT === '465';
const CONNECTION_TIMEOUT   = 30_000;   // 30 s — evita timeout en Gmail SMTP
const SOCKET_TIMEOUT       = 30_000;   // 30 s — tiempo máximo de inactividad
const MAX_RETRIES          = 3;        // reintentos automáticos ante fallo
const RETRY_BASE_DELAY_MS  = 2_000;   // backoff exponencial: 2 s, 4 s, 8 s

// ── Crear transporter con pool de conexiones ──────────────────
const transporter = nodemailer.createTransport({
  host:              SMTP_HOST,
  port:              SMTP_PORT,
  secure:            SMTP_SECURE,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // Pool de conexiones: reutiliza sockets en lugar de abrir uno por email
  pool:              true,
  maxConnections:    5,
  maxMessages:       100,
  // Timeouts extendidos para tolerar latencia de Gmail SMTP
  connectionTimeout: CONNECTION_TIMEOUT,
  socketTimeout:     SOCKET_TIMEOUT,
  greetingTimeout:   CONNECTION_TIMEOUT,
  logger:            false,   // desactivado; usamos winston directamente
  debug:             false,
});

// Verificar conectividad al iniciar (no bloquea el arranque)
transporter.verify((err) => {
  if (err) {
    logger.warn('SMTP verify falló al iniciar — se reintentará en cada envío', {
      host:    SMTP_HOST,
      port:    SMTP_PORT,
      secure:  SMTP_SECURE,
      error:   err.message,
    });
  } else {
    logger.info('SMTP listo', { host: SMTP_HOST, port: SMTP_PORT });
  }
});

// ── Template base HTML ────────────────────────────────────────
const baseTemplate = (content) => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GestionAr</title>
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
      <h1>🏘️ GestionAr</h1>
      <span>Administración de Barrio Privado</span>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      <p>Este mensaje fue enviado automáticamente. Por favor no respondas este email.</p>
      <p>© 2025 GestionAr — Todos los derechos reservados.</p>
    </div>
  </div>
</body>
</html>`;

// ── Helpers internos ──────────────────────────────────────────

/** Espera `ms` milisegundos (usado en el backoff entre reintentos). */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Determina si un error de nodemailer es transitorio y vale la pena reintentar.
 * Errores de autenticación o dirección inválida no se reintentan.
 */
const isRetryable = (err) => {
  const transientCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'ENOTFOUND'];
  if (transientCodes.includes(err.code)) return true;
  // nodemailer expone responseCode para errores SMTP 4xx (temporales)
  if (err.responseCode && err.responseCode >= 400 && err.responseCode < 500) return true;
  return false;
};

// ── Función genérica para enviar email (con reintentos) ───────
const sendEmail = async ({ to, subject, html }) => {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('Enviando email', { to, subject, attempt, maxRetries: MAX_RETRIES });

      const info = await transporter.sendMail({
        from:    process.env.EMAIL_FROM || '"GestionAr" <noreply@consorcio.com>',
        to,
        subject,
        html,
      });

      logger.info('Email enviado correctamente', {
        to,
        subject,
        messageId: info.messageId,
        attempt,
      });
      return info;

    } catch (err) {
      lastErr = err;

      logger.warn('Fallo al enviar email', {
        to,
        subject,
        attempt,
        maxRetries:    MAX_RETRIES,
        errorCode:     err.code,
        errorMessage:  err.message,
        responseCode:  err.responseCode,
        command:       err.command,
      });

      // Si el error no es transitorio, no tiene sentido reintentar
      if (!isRetryable(err)) {
        logger.error('Error no transitorio — se cancela el reintento', {
          to,
          subject,
          errorCode:    err.code,
          errorMessage: err.message,
        });
        break;
      }

      // Si quedan intentos, esperar con backoff exponencial antes del siguiente
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.info(`Reintentando en ${delay / 1000}s…`, { to, subject, nextAttempt: attempt + 1 });
        await sleep(delay);
      }
    }
  }

  logger.error('Email no pudo ser enviado tras todos los intentos', {
    to,
    subject,
    totalAttempts: MAX_RETRIES,
    finalError:    lastErr?.message,
    errorCode:     lastErr?.code,
  });
  throw lastErr;
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
    subject: `✓ Pago aprobado — ${payment.monthFormatted} | GestionAr`,
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
    subject: `Comprobante rechazado — ${payment.monthFormatted} | GestionAr`,
    html,
  });
};

// Bienvenida a nuevo propietario
exports.sendWelcome = async (owner, tempPassword) => {
  const html = baseTemplate(`
    <p>Hola <strong>${owner.name}</strong>,</p>
    <p>¡Bienvenido/a a GestionAr! Tu cuenta ha sido creada correctamente.</p>
    <div class="highlight">
      <p>Email: ${owner.email}</p>
      <p>Contraseña temporal: <strong>${tempPassword}</strong></p>
      <p>Unidad: ${owner.unit || '—'}</p>
    </div>
    <p>Te recomendamos cambiar tu contraseña al ingresar por primera vez.</p>
    <a href="${process.env.APP_BASE_URL}" class="btn">Ingresar a GestionAr</a>
    <p style="margin-top:20px">Si tenés problemas para ingresar, contactá al administrador.</p>
  `);
  return sendEmail({
    to:      owner.email,
    subject: '¡Bienvenido/a a GestionAr! Tu acceso está listo.',
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
    subject: 'Restablecé tu contraseña — GestionAr',
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
