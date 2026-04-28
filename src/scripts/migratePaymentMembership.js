/**
 * Migración idempotente: asigna membership a pagos que no lo tienen.
 * Busca el OrganizationMember correspondiente a (owner, organization) de cada payment.
 *
 * Uso: npm run migrate:payment-membership
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose           = require('mongoose');
const Payment            = require('../models/Payment');
const OrganizationMember = require('../models/OrganizationMember');
const logger             = require('../config/logger');

const migrate = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  logger.info('Conectado a MongoDB para migración de memberships en pagos.');

  const payments = await Payment.find({ membership: { $exists: false } })
    .select('_id owner organization')
    .lean();

  logger.info(`Pagos sin membership encontrados: ${payments.length}`);

  let migrados  = 0;
  let omitidos  = 0;
  const ambiguos = [];

  for (const payment of payments) {
    const member = await OrganizationMember.findOne({
      user:         payment.owner,
      organization: payment.organization,
    }).select('_id').lean();

    if (member) {
      await Payment.updateOne({ _id: payment._id }, { $set: { membership: member._id } });
      migrados++;
    } else {
      omitidos++;
      ambiguos.push({
        paymentId:    payment._id.toString(),
        owner:        payment.owner?.toString(),
        organization: payment.organization?.toString(),
      });
    }
  }

  logger.info('─────────────────────────────────────────');
  logger.info('Migración completada:');
  logger.info(`  Pagos migrados:            ${migrados}`);
  logger.info(`  Pagos omitidos (ambiguos): ${omitidos}`);
  logger.info(`  Total procesados:          ${payments.length}`);

  if (ambiguos.length > 0) {
    logger.warn('Pagos que requieren revisión manual (sin OrganizationMember encontrado):');
    for (const p of ambiguos) {
      logger.warn(`  paymentId=${p.paymentId}  owner=${p.owner}  org=${p.organization}`);
    }
  }

  logger.info('─────────────────────────────────────────');

  await mongoose.disconnect();
  process.exit(0);
};

migrate().catch((err) => {
  logger.error(`Error fatal en migración: ${err.message}`);
  process.exit(1);
});
