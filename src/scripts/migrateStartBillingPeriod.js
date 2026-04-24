/**
 * Migración: asigna startBillingPeriod a propietarios que no lo tienen.
 *
 * Lógica: usa el mes de createdAt del usuario como período de inicio.
 * Se ejecuta una sola vez y es idempotente (solo actualiza documentos sin el campo).
 *
 * Uso:
 *   node src/scripts/migrateStartBillingPeriod.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('../models/User');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB.');

  const owners = await User.find({
    role:               'owner',
    startBillingPeriod: { $exists: false },
  }).select('_id email createdAt');

  console.log(`Propietarios sin startBillingPeriod: ${owners.length}`);

  let updated = 0;
  for (const owner of owners) {
    const d      = new Date(owner.createdAt);
    const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    await User.updateOne({ _id: owner._id }, { $set: { startBillingPeriod: period } });
    updated++;
    if (updated % 50 === 0) console.log(`  Actualizados: ${updated}/${owners.length}`);
  }

  console.log(`Migración completa: ${updated} propietario${updated !== 1 ? 's' : ''} actualizados.`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Error en migración:', err.message);
  process.exit(1);
});
