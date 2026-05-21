/**
 * Migracion idempotente: OrganizationMember/User billing legacy -> Unit.
 *
 * Dry-run:
 *   node src/scripts/migrateUnitBillingSettings.js --organizationSlug eden-6
 *
 * Aplicar:
 *   node src/scripts/migrateUnitBillingSettings.js --organizationSlug eden-6 --apply
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Unit = require('../models/Unit');
const User = require('../models/User');
const { normalizeDebtBalance } = require('../utils/ownerFinance');
const { assertMongoEnvironment } = require('../config/environmentGuard');

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function findOrganization() {
  const organizationId = argValue('--organizationId');
  const organizationSlug = argValue('--organizationSlug');
  if (!organizationId && !organizationSlug) {
    throw new Error('Indica --organizationId o --organizationSlug.');
  }

  return Organization.findOne({
    ...(organizationId ? { _id: organizationId } : { slug: organizationSlug }),
  }).select('_id name slug').lean();
}

async function run() {
  const apply = hasArg('--apply');
  assertMongoEnvironment({ operation: apply ? 'write-script' : 'read-script' });
  await mongoose.connect(process.env.MONGODB_URI);

  const org = await findOrganization();
  if (!org) throw new Error('Organizacion no encontrada.');

  const memberships = await OrganizationMember.find({
    organization: org._id,
    role: 'owner',
    isActive: true,
  }).populate('user', 'name email startBillingPeriod').lean();

  const report = {
    organization: { id: org._id.toString(), name: org.name, slug: org.slug },
    mode: apply ? 'apply' : 'dry-run',
    copiedStartBilling: [],
    copiedSingleUnitDebt: [],
    distributedLegacyDebt: [],
    skippedDebt: [],
  };

  for (const member of memberships) {
    const ownerId = member.user?._id || member.user;
    if (!ownerId) continue;

    const units = await Unit.find({
      organization: org._id,
      owner: ownerId,
      active: true,
    }).sort({ name: 1 });

    const legacyStart = member.startBillingPeriod || member.user?.startBillingPeriod;
    const unitsMissingStart = units.filter(unit => !unit.startBillingPeriod);
    if (legacyStart && unitsMissingStart.length) {
      report.copiedStartBilling.push({
        ownerId: ownerId.toString(),
        owner: member.user?.name,
        startBillingPeriod: legacyStart,
        units: unitsMissingStart.map(unit => ({ id: unit._id.toString(), name: unit.name })),
      });
      if (apply) {
        await Unit.updateMany(
          { _id: { $in: unitsMissingStart.map(unit => unit._id) }, organization: org._id },
          { $set: { startBillingPeriod: legacyStart } }
        );
      }
    }

    const legacyDebt = normalizeDebtBalance(member.balance || 0);
    if (legacyDebt >= 0) continue;
    const unitsWithDebt = units.filter(unit => normalizeDebtBalance(unit.balance) < 0);
    if (unitsWithDebt.length) {
      report.skippedDebt.push({
        ownerId: ownerId.toString(),
        owner: member.user?.name,
        balance: legacyDebt,
        reason: 'Las unidades ya tienen deuda registrada.',
      });
      continue;
    }

    if (units.length === 1) {
      report.copiedSingleUnitDebt.push({
        ownerId: ownerId.toString(),
        owner: member.user?.name,
        unit: { id: units[0]._id.toString(), name: units[0].name },
        balance: legacyDebt,
      });
      if (apply) {
        await Unit.updateOne(
          { _id: units[0]._id, organization: org._id },
          { $set: { balance: legacyDebt, isDebtor: true } }
        );
      }
      continue;
    }

    if (units.length > 1) {
      const perUnitDebt = normalizeDebtBalance(Math.abs(legacyDebt) / units.length);
      report.distributedLegacyDebt.push({
        ownerId: ownerId.toString(),
        owner: member.user?.name,
        originalBalance: legacyDebt,
        perUnitDebt,
        units: units.map(unit => ({ id: unit._id.toString(), name: unit.name })),
      });
      if (apply) {
        await Unit.updateMany(
          { _id: { $in: units.map(unit => unit._id) }, organization: org._id },
          { $set: { balance: perUnitDebt, isDebtor: true } }
        );
      }
      continue;
    }

    report.skippedDebt.push({
      ownerId: ownerId.toString(),
      owner: member.user?.name,
      balance: legacyDebt,
      reason: 'El propietario no tiene unidades activas.',
    });
  }

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

run().catch(async err => {
  console.error(err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
