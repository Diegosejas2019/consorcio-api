/**
 * Script de validación multi-org.
 * Detecta inconsistencias en la estructura de datos post-refactor.
 *
 * Uso: node src/scripts/validateMultiOrg.js
 */
require('dotenv').config();
const mongoose           = require('mongoose');
const User               = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Payment            = require('../models/Payment');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB\n');

  let errors = 0;
  let warnings = 0;

  // ── 1. Users activos sin ninguna membresía activa ─────────────
  const activeUsers = await User.find({ isActive: true, role: 'owner' }).select('_id email');
  const userIds = activeUsers.map(u => u._id);
  const membersWithUsers = await OrganizationMember.distinct('user', { isActive: true });
  const memberSet = new Set(membersWithUsers.map(id => id.toString()));

  const orphanOwners = activeUsers.filter(u => !memberSet.has(u._id.toString()));
  if (orphanOwners.length > 0) {
    console.error(`❌ [ERROR] Owners activos sin membresía activa (${orphanOwners.length}):`);
    orphanOwners.forEach(u => console.error(`   - ${u.email} (${u._id})`));
    errors += orphanOwners.length;
  } else {
    console.log(`✅ Todos los owners activos tienen al menos 1 membresía activa`);
  }

  // ── 2. OrganizationMembers duplicados (mismo user+org+role) ───
  const dupPipeline = [
    { $group: { _id: { user: '$user', organization: '$organization', role: '$role' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ];
  const duplicates = await OrganizationMember.aggregate(dupPipeline);
  if (duplicates.length > 0) {
    console.error(`❌ [ERROR] OrganizationMembers duplicados (${duplicates.length} grupos):`);
    duplicates.forEach(d => console.error(`   - user=${d._id.user} org=${d._id.organization} role=${d._id.role} (${d.count} docs)`));
    errors += duplicates.length;
  } else {
    console.log(`✅ Sin OrganizationMembers duplicados`);
  }

  // ── 3. Pagos sin campo organization ───────────────────────────
  const paymentsWithoutOrg = await Payment.countDocuments({ organization: { $exists: false } });
  if (paymentsWithoutOrg > 0) {
    console.error(`❌ [ERROR] Pagos sin campo organization: ${paymentsWithoutOrg}`);
    errors++;
  } else {
    console.log(`✅ Todos los pagos tienen campo organization`);
  }

  // ── 4. Pagos sin membership (informativo) ─────────────────────
  const paymentsWithoutMembership = await Payment.countDocuments({
    paymentMethod: 'mercadopago',
    membership: { $exists: false },
  });
  if (paymentsWithoutMembership > 0) {
    console.warn(`⚠️  [WARN] Pagos MP sin campo membership (legacy): ${paymentsWithoutMembership}`);
    warnings++;
  } else {
    console.log(`✅ Todos los pagos MP tienen campo membership`);
  }

  // ── 5. OrganizationMember con balance != 0 sin User vinculado ─
  const memberIds = await OrganizationMember.distinct('user', { isActive: true });
  const existingUserIds = await User.distinct('_id', { _id: { $in: memberIds } });
  const existingSet = new Set(existingUserIds.map(id => id.toString()));
  const orphanMembers = memberIds.filter(id => !existingSet.has(id.toString()));
  if (orphanMembers.length > 0) {
    console.error(`❌ [ERROR] OrganizationMembers activos apuntando a Users inexistentes (${orphanMembers.length})`);
    orphanMembers.forEach(id => console.error(`   - userId: ${id}`));
    errors += orphanMembers.length;
  } else {
    console.log(`✅ Todos los OrganizationMembers activos apuntan a Users existentes`);
  }

  // ── Resumen ───────────────────────────────────────────────────
  console.log(`\n── Resumen ──────────────────────────────────────`);
  console.log(`   Errores críticos: ${errors}`);
  console.log(`   Advertencias:     ${warnings}`);

  await mongoose.disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Error en validación:', err.message);
  process.exit(1);
});
