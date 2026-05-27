/**
 * Migracion idempotente: reemplaza el indice unico legacy de pagos
 * { owner, month } por { organization, owner, month }.
 *
 * Uso: npm run migrate:payment-index
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const logger = require('../config/logger');

const OLD_INDEX = 'owner_1_month_1';
const NEW_INDEX = 'organization_1_owner_1_month_1';

async function dropIndexIfExists(collection, name) {
  const indexes = await collection.indexes();
  if (!indexes.some((index) => index.name === name)) return false;
  await collection.dropIndex(name);
  return true;
}

async function assertNoActiveDuplicates() {
  const duplicates = await Payment.aggregate([
    {
      $match: {
        organization: { $exists: true, $ne: null },
        owner: { $exists: true, $ne: null },
        month: { $exists: true, $ne: null },
        status: { $in: ['pending', 'approved'] },
      },
    },
    {
      $group: {
        _id: { organization: '$organization', owner: '$owner', month: '$month' },
        count: { $sum: 1 },
        ids: { $push: '$_id' },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 },
  ]);

  if (!duplicates.length) return;

  logger.error('No se puede crear el indice unico: hay pagos activos duplicados por organizacion/owner/mes.');
  duplicates.forEach((item) => {
    logger.error(
      `org=${item._id.organization} owner=${item._id.owner} month=${item._id.month} ids=${item.ids.join(',')}`
    );
  });
  throw new Error('Resolver duplicados antes de ejecutar la migracion.');
}

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  logger.info('Conectado a MongoDB para migracion de indice unico de pagos.');

  await assertNoActiveDuplicates();

  const collection = Payment.collection;
  const droppedOld = await dropIndexIfExists(collection, OLD_INDEX);
  const droppedNew = await dropIndexIfExists(collection, NEW_INDEX);

  await collection.createIndex(
    { organization: 1, owner: 1, month: 1 },
    {
      name: NEW_INDEX,
      unique: true,
      sparse: true,
      partialFilterExpression: { status: { $in: ['pending', 'approved'] } },
    }
  );

  logger.info(`Indice legacy eliminado: ${droppedOld ? 'si' : 'no existia'}`);
  logger.info(`Indice organization/owner/month reemplazado: ${droppedNew ? 'si' : 'no existia'}`);
  logger.info('Indice unico de pagos actualizado correctamente.');

  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch(async (err) => {
  logger.error(`Error fatal en migracion de indice de pagos: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
