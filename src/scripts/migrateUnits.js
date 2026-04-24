/**
 * Script de migración: user.unit (string) → Unit (documento)
 *
 * Uso: node src/scripts/migrateUnits.js
 *
 * Por cada propietario con user.unit != '' crea un documento Unit
 * con coefficient=1 si no existe ya uno con ese nombre para ese owner.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('../models/User');
const Unit     = require('../models/Unit');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✔ Conectado a MongoDB');

  const owners = await User.find({
    role:     'owner',
    isActive: true,
    unit:     { $nin: [null, ''] },
  }).select('_id name email unit organization');

  console.log(`\nPropietarios con campo unit: ${owners.length}`);

  let created  = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const owner of owners) {
    try {
      const exists = await Unit.findOne({
        owner:        owner._id,
        organization: owner.organization,
        name:         owner.unit,
      });

      if (exists) {
        console.log(`  ↷ Ya existe: ${owner.email} — "${owner.unit}"`);
        skipped++;
        continue;
      }

      await Unit.create({
        organization: owner.organization,
        owner:        owner._id,
        name:         owner.unit,
        coefficient:  1,
        customFee:    null,
        active:       true,
      });

      console.log(`  ✔ Migrado: ${owner.email} — "${owner.unit}"`);
      created++;
    } catch (err) {
      console.error(`  ✖ Error con ${owner.email}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n── Resumen ──────────────────────────────`);
  console.log(`  Creados:  ${created}`);
  console.log(`  Omitidos: ${skipped} (ya existían)`);
  console.log(`  Errores:  ${errors}`);
  console.log(`─────────────────────────────────────────\n`);

  await mongoose.disconnect();
  console.log('✔ Desconectado. Migración finalizada.');
  process.exit(errors > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
