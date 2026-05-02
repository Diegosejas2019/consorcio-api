/**
 * Migración: User.unit (string) → Unit (documento relacional)
 *
 * Uso: node src/scripts/migrateUnits.js
 *
 * Por cada propietario con user.unit != '':
 *  - Normaliza el nombre ("LOTE 01" → "Lote 1")
 *  - Detecta duplicados por org (dos owners con el mismo lote normalizado)
 *  - Crea el Unit si no existe (status: 'occupied')
 *  - Asigna unit.owner y user.unitId
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('../models/User');
const Unit     = require('../models/Unit');

function normalizeLotName(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())  // capitalizar cada palabra
    .replace(/\b0+(\d+)\b/g, '$1');          // quitar ceros: "01" → "1"
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✔ Conectado a MongoDB\n');

  const owners = await User.find({
    role:     'owner',
    isActive: true,
    unit:     { $nin: [null, ''] },
  }).select('_id name email unit organization unitId');

  console.log(`Propietarios con campo unit: ${owners.length}\n`);

  // Agrupar por organización
  const byOrg = {};
  for (const o of owners) {
    const orgId = o.organization?.toString();
    if (!orgId) continue;
    (byOrg[orgId] ||= []).push(o);
  }

  let created   = 0;
  let skipped   = 0;
  let conflicts = 0;
  let errors    = 0;
  const conflictLog = [];

  for (const [orgId, orgOwners] of Object.entries(byOrg)) {
    // Detectar duplicados por nombre normalizado
    const byName = {};
    for (const o of orgOwners) {
      const name = normalizeLotName(o.unit);
      (byName[name] ||= []).push(o);
    }

    for (const [name, group] of Object.entries(byName)) {
      if (group.length > 1) {
        const emails = group.map(o => o.email).join(', ');
        const msg = `CONFLICTO en org ${orgId}: "${name}" tiene ${group.length} propietarios (${emails})`;
        console.warn(`  ⚠ ${msg}`);
        conflictLog.push(msg);
        conflicts += group.length;
        continue;
      }

      const owner = group[0];

      // Si ya tiene unitId asignado, verificar que sea correcto
      if (owner.unitId) {
        console.log(`  ↷ Ya migrado: ${owner.email} — "${name}"`);
        skipped++;
        continue;
      }

      try {
        let unit = await Unit.findOne({ organization: orgId, name });

        if (!unit) {
          unit = await Unit.create({
            organization: orgId,
            owner:        owner._id,
            status:       'occupied',
            name,
            coefficient:  1,
            customFee:    null,
            active:       true,
          });
        } else if (!unit.owner) {
          await Unit.findByIdAndUpdate(unit._id, { owner: owner._id, status: 'occupied' });
        }

        await User.findByIdAndUpdate(owner._id, { unitId: unit._id });

        console.log(`  ✔ Migrado: ${owner.email} — "${name}"`);
        created++;
      } catch (err) {
        console.error(`  ✖ Error con ${owner.email}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log('\n── Resumen ──────────────────────────────────────');
  console.log(`  Migrados:   ${created}`);
  console.log(`  Ya estaban: ${skipped}`);
  console.log(`  Conflictos: ${conflicts} propietarios en ${conflictLog.length} lotes`);
  console.log(`  Errores:    ${errors}`);

  if (conflictLog.length > 0) {
    console.log('\n── Lotes con conflicto (requieren asignación manual) ────');
    conflictLog.forEach(m => console.log(`  • ${m}`));
  }

  console.log('─────────────────────────────────────────────────\n');

  await mongoose.disconnect();
  console.log('✔ Desconectado. Migración finalizada.');
  process.exit(errors > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
