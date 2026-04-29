const emailService = require('./emailService');
const logger       = require('../config/logger');

const TYPE_LABELS = {
  bug: 'Error en la app',
  question: 'Consulta',
  payment_issue: 'Problema con pago',
  suggestion: 'Sugerencia',
  other: 'Otro',
};

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function notifyTicketCreated(ticket) {
  const to = process.env.SUPPORT_EMAIL;
  if (!to) {
    logger.info('SUPPORT_EMAIL no configurado; se omite email interno de soporte.');
    return;
  }

  if (!process.env.BREVO_API_KEY) {
    logger.warn('BREVO_API_KEY no configurado; no se pudo enviar email interno de soporte.');
    return;
  }

  const typeLabel = TYPE_LABELS[ticket.type] || ticket.type;
  const orgName   = ticket.organizationId?.name || ticket.organizationId || 'Sin organizacion';
  const userName  = ticket.userId?.name || ticket.userId || 'Usuario no disponible';
  const userEmail = ticket.userId?.email ? ` (${ticket.userId.email})` : '';
  const route     = ticket.context?.route || '-';
  const createdAt = new Date(ticket.createdAt || Date.now()).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });

  const html = `
    <h2>Nuevo ticket de soporte</h2>
    <p><strong>Titulo:</strong> ${escapeHtml(ticket.title)}</p>
    <p><strong>Descripcion:</strong></p>
    <p>${escapeHtml(ticket.description).replace(/\n/g, '<br>')}</p>
    <hr>
    <p><strong>Tipo:</strong> ${escapeHtml(typeLabel)}</p>
    <p><strong>Organizacion:</strong> ${escapeHtml(orgName)}</p>
    <p><strong>Usuario:</strong> ${escapeHtml(userName)}${escapeHtml(userEmail)}</p>
    <p><strong>Rol:</strong> ${escapeHtml(ticket.userRole)}</p>
    <p><strong>Ruta:</strong> ${escapeHtml(route)}</p>
    <p><strong>Fecha:</strong> ${escapeHtml(createdAt)}</p>
  `;

  try {
    await emailService.sendEmail({
      to,
      subject: `Nuevo ticket de soporte - ${ticket.type}`,
      html,
    });
  } catch (err) {
    logger.warn(`No se pudo enviar email interno de soporte: ${err.message}`);
  }
}

module.exports = { notifyTicketCreated };
