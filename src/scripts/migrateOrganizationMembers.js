/**
 * Migración idempotente: crea OrganizationMember para cada User con organización.
 * Uso: npm run migrate:members
 * Puede ejecutarse múltiples veces sin duplicar registros.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose          = require('mongoose');
const User              = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const logger            = require('../config/logger');

const migrate = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  logger.info('Conectado a MongoDB para migración.');

  const users = await User.find({ organization: { $ne: null } }).lean();
  logger.info(`Usuarios con organización encontrados: ${users.length}`);

  let creados = 0;
  let yaExistian = 0;
  let errores = 0;

  for (const user of users) {
    try {
      const filter = {
        user:         user._id,
        organization: user.organization,
        role:         user.role,
      };

      const update = {
        $setOnInsert: {
          balance:            user.balance            ?? 0,
          isDebtor:           user.isDebtor           ?? false,
          startBillingPeriod: user.startBillingPeriod ?? undefined,
          percentage:         user.percentage         ?? 0,
          isActive:           user.isActive           ?? true,
          createdBy:          user.createdBy          ?? undefined,
        },
      };

      const result = await OrganizationMember.updateOne(filter, update, { upsert: true });

      if (result.upsertedCount > 0) {
        creados++;
      } else {
        yaExistian++;
      }
    } catch (err) {
      errores++;
      logger.error(`Error al migrar usuario ${user._id} (${user.email}): ${err.message}`);
    }
  }

  logger.info('─────────────────────────────────────────');
  logger.info(`Migración completada:`);
  logger.info(`  Memberships creados:       ${creados}`);
  logger.info(`  Ya existían:               ${yaExistian}`);
  logger.info(`  Errores:                   ${errores}`);
  logger.info(`  Total procesados:          ${users.length}`);
  logger.info('─────────────────────────────────────────');

  await mongoose.disconnect();
  process.exit(0);
};

migrate().catch((err) => {
  logger.error(`Error fatal en migración: ${err.message}`);
  process.exit(1);
});
