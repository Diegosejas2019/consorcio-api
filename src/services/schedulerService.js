const cron         = require('node-cron');
const Organization = require('../models/Organization');
const Payment      = require('../models/Payment');
const User         = require('../models/User');
const firebase     = require('./firebaseService');
const logger       = require('../config/logger');

// ── Lógica central — reutilizable por cron y endpoint manual ─
async function sendDueDateReminders(org) {
  const month = org.feePeriodCode;
  if (!month) {
    logger.warn(`[Scheduler] Org ${org._id} sin feePeriodCode configurado, se omite.`);
    return { sent: 0, noToken: 0, skipped: true };
  }

  // Owners que ya tienen pago aprobado este mes
  const paidIds = (await Payment.find({
    organization: org._id,
    month,
    status: 'approved',
  })).map(p => p.owner.toString());

  // Owners activos sin pago aprobado
  const unpaid = await User.find({
    organization: org._id,
    role: 'owner',
    isActive: true,
    _id: { $nin: paidIds },
  }).select('+fcmToken');

  const tokens = unpaid.map(u => u.fcmToken).filter(Boolean);
  logger.info(`[Scheduler] Org ${org._id}: ${unpaid.length} sin pago, ${tokens.length} token(s) FCM`);

  if (tokens.length === 0) return { sent: 0, noToken: unpaid.length };

  const feeLabel = org.feeLabel || 'Expensa';
  const amount   = org.feeAmount?.toLocaleString('es-AR') ?? '0';

  await firebase.sendMulticast(tokens, {
    title: `Vencimiento de ${feeLabel}`,
    body:  `Tu ${feeLabel} de $${amount} vence hoy. Podés pagar desde la app.`,
    data:  { type: 'due_date_reminder', month },
  });

  return { sent: tokens.length, noToken: unpaid.length - tokens.length };
}

// ── Cron: diario a las 09:00 UTC ─────────────────────────────
function initScheduler() {
  cron.schedule('0 9 * * *', async () => {
    logger.info('[Scheduler] Ejecutando verificación de vencimientos...');
    try {
      const today = new Date().getDate(); // día del mes actual (1-31)
      const orgs  = await Organization.find({ dueDayOfMonth: today });
      logger.info(`[Scheduler] ${orgs.length} org(s) con vencimiento hoy (día ${today})`);
      for (const org of orgs) {
        await sendDueDateReminders(org);
      }
    } catch (err) {
      logger.error(`[Scheduler] Error en cron: ${err.message}`, { stack: err.stack });
    }
  });
  logger.info('[Scheduler] Cron inicializado — se ejecuta diariamente a las 09:00 UTC');
}

module.exports = { initScheduler, sendDueDateReminders };
