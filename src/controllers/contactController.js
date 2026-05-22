const emailService = require('../services/emailService');
const logger       = require('../config/logger');

const SUCCESS_MESSAGE = 'Recibimos tu solicitud. Te contactamos en menos de 48 h hábiles.';
const CONTACT_RANGES = {
  consortia: ['1 - 3', '4 - 10', '11 - 30', 'Más de 30'],
  units: ['Hasta 200', '200 - 600', '600 - 2.000', 'Más de 2.000'],
};

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate() {
  return new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

function buildDemoRequestEmail(data) {
  const message = data.message
    ? escapeHtml(data.message).replace(/\n/g, '<br>')
    : 'Sin mensaje adicional.';

  return `
    <h2>Nueva solicitud de demo</h2>
    <p>Una persona completó el formulario público de GestionAr.</p>
    <hr>
    <p><strong>Nombre:</strong> ${escapeHtml(data.name)}</p>
    <p><strong>Administración:</strong> ${escapeHtml(data.administration)}</p>
    <p><strong>Email:</strong> ${escapeHtml(data.email)}</p>
    <p><strong>Teléfono:</strong> ${escapeHtml(data.phone)}</p>
    <p><strong>Consorcios aprox.:</strong> ${escapeHtml(data.consortiaRange)}</p>
    <p><strong>Unidades / lotes aprox.:</strong> ${escapeHtml(data.unitsRange)}</p>
    <p><strong>Mensaje:</strong></p>
    <p>${message}</p>
    <hr>
    <p><strong>Fecha:</strong> ${escapeHtml(formatDate())}</p>
  `;
}

exports.skipHoneypot = (req, res, next) => {
  if (String(req.body.website || '').trim()) {
    return res.status(200).json({ success: true, message: SUCCESS_MESSAGE });
  }
  next();
};

exports.createDemoRequest = async (req, res, next) => {
  try {
    const data = {
      name: String(req.body.name || '').trim(),
      administration: String(req.body.administration || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase(),
      phone: String(req.body.phone || '').trim(),
      consortiaRange: String(req.body.consortiaRange || '').trim(),
      unitsRange: String(req.body.unitsRange || '').trim(),
      message: String(req.body.message || '').trim(),
    };

    const to = process.env.CONTACT_REQUEST_TO
      || process.env.SUPPORT_EMAIL
      || 'gestionar.app.info@gmail.com';

    await emailService.sendEmail({
      to,
      subject: `Nueva solicitud de demo - ${data.administration}`,
      html: buildDemoRequestEmail(data),
      replyTo: { email: data.email, name: data.name },
    });

    res.status(200).json({ success: true, message: SUCCESS_MESSAGE });
  } catch (err) {
    logger.error(`No se pudo enviar solicitud de demo: ${err.message}`);
    err.statusCode = 500;
    err.message = 'No pudimos enviar tu solicitud. Intentá nuevamente en unos minutos.';
    next(err);
  }
};

exports.CONTACT_RANGES = CONTACT_RANGES;
exports.SUCCESS_MESSAGE = SUCCESS_MESSAGE;
