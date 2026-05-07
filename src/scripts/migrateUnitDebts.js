/**
 * Migración idempotente: OrganizationMember.balance -> Unit.balance.
 *
 * Dry-run por defecto:
 *   node src/scripts/migrateUnitDebts.js --organizationSlug eden-6
 *
 * Aplicar cambios:
 *   node src/scripts/migrateUnitDebts.js --organizationSlug eden-6 --apply
 *
 * Mapeo manual JSON:
 *   [{ "organizationSlug": "eden-6", "memberId": "...", "unitId": "...", "balance": -390000 }]
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Unit = require('../models/Unit');
require('../models/User');

const EDEN_6_ID = '69e6112cbf9c073c237b12a5';
const EDEN_6_SLUG = 'eden-6';

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function normalizeBalance(raw) {
  const amount = Number(raw || 0);
  if (!Number.isFinite(amount)) return 0;
  return amount > 0 ? -amount : amount;
}

function normalizeUnitName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\b0+(\d+)\b/g, '$1')
    .replace(/\s+/g, ' ');
}

function parseManualRows(filePath) {
  if (!filePath) return [];
  const fullPath = path.resolve(filePath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  if (fullPath.toLowerCase().endsWith('.json')) return JSON.parse(raw);

  return raw.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(1)
    .map(line => {
      const [organizationSlug, memberId, unitId, balance] = line.split(',').map(v => v.trim());
      return { organizationSlug, memberId, unitId, balance: Number(balance) };
    });
}

async function findOrganization() {
  const organizationId = argValue('--organizationId');
  const organizationSlug = argValue('--organizationSlug');
  if (!organizationId && !organizationSlug) {
    throw new Error('Indicá --organizationId o --organizationSlug.');
  }

  return Organization.findOne({
    ...(organizationId ? { _id: organizationId } : { slug: organizationSlug }),
  }).select('_id name slug').lean();
}

async function run() {
  const apply = hasArg('--apply');
  const manualRows = parseManualRows(argValue('--manual'));

  await mongoose.connect(process.env.MONGODB_URI);
  const org = await findOrganization();
  if (!org) throw new Error('Organización no encontrada.');

  const isEden6 = org._id.toString() === EDEN_6_ID || org.slug === EDEN_6_SLUG;
  const memberships = await OrganizationMember.find({
    organization: org._id,
    role: 'owner',
    isActive: true,
  }).populate('user', 'name email').lean();
  const units = await Unit.find({ organization: org._id, active: true })
    .select('_id name owner balance isDebtor startBillingPeriod')
    .lean();

  const unitsByOwner = {};
  const unitsByName = {};
  for (const unit of units) {
    if (unit.owner) (unitsByOwner[unit.owner.toString()] ||= []).push(unit);
    (unitsByName[normalizeUnitName(unit.name)] ||= []).push(unit);
  }
  const duplicateNames = Object.entries(unitsByName)
    .filter(([, group]) => group.length > 1)
    .map(([name, group]) => ({ name, units: group.map(unit => ({ id: unit._id.toString(), name: unit.name })) }));

  const manualByMember = {};
  for (const row of manualRows) {
    if (row.organizationSlug && row.organizationSlug !== org.slug) continue;
    (manualByMember[row.memberId] ||= []).push({
      unitId: row.unitId,
      balance: normalizeBalance(row.balance),
    });
  }

  const report = {
    organization: { id: org._id.toString(), name: org.name, slug: org.slug },
    mode: apply ? 'apply' : 'dry-run',
    duplicateNames,
    copiedStartBilling: 0,
    autoDebtRows: [],
    manualDebtRows: [],
    ambiguousRows: [],
    skippedNoDebt: 0,
  };
  const startBillingUpdates = [];
  const debtUpdates = [];

  for (const member of memberships) {
    const ownerId = member.user?._id?.toString() || member.user?.toString();
    const ownerUnits = unitsByOwner[ownerId] || [];
    const memberId = member._id.toString();
    const balance = normalizeBalance(member.balance);

    if (member.startBillingPeriod && ownerUnits.length) {
      const missingStartUnits = ownerUnits.filter(unit => !unit.startBillingPeriod);
      report.copiedStartBilling += missingStartUnits.length;
      for (const unit of missingStartUnits) {
        startBillingUpdates.push({ unitId: unit._id, startBillingPeriod: member.startBillingPeriod });
      }
    }

    if (balance === 0) {
      report.skippedNoDebt++;
      continue;
    }

    const manual = manualByMember[memberId];
    if (manual?.length) {
      const manualSum = manual.reduce((sum, row) => sum + row.balance, 0);
      if (manualSum !== balance) {
        report.ambiguousRows.push({
          memberId,
          owner: member.user?.name,
          balance,
          reason: 'La suma del mapeo manual no coincide con la deuda original.',
          manualSum,
        });
        continue;
      }
      report.manualDebtRows.push({ memberId, owner: member.user?.name, balance, rows: manual });
      for (const row of manual) {
        debtUpdates.push({ unitId: row.unitId, balance: row.balance });
      }
      continue;
    }

    const normalizedNames = new Set(ownerUnits.map(unit => normalizeUnitName(unit.name)));
    const hasDuplicate = ownerUnits.some(unit => (unitsByName[normalizeUnitName(unit.name)] || []).length > 1);
    if (ownerUnits.length !== 1 || normalizedNames.size !== ownerUnits.length || hasDuplicate) {
      report.ambiguousRows.push({
        memberId,
        ownerId,
        owner: member.user?.name,
        email: member.user?.email,
        balance,
        units: ownerUnits.map(unit => ({ id: unit._id.toString(), name: unit.name })),
        reason: ownerUnits.length === 0 ? 'Sin unidad activa' : 'Más de una unidad o nombre duplicado',
      });
      continue;
    }

    const [unit] = ownerUnits;
    report.autoDebtRows.push({
      memberId,
      owner: member.user?.name,
      email: member.user?.email,
      balance,
      unit: { id: unit._id.toString(), name: unit.name },
    });
    debtUpdates.push({ unitId: unit._id, balance });
  }

  if (apply && isEden6 && report.ambiguousRows.length > 0) {
    console.log(JSON.stringify(report, null, 2));
    throw new Error('Eden 6 tiene casos ambiguos. Aplicá con --manual para resolverlos antes.');
  }

  if (apply) {
    for (const update of startBillingUpdates) {
      await Unit.updateOne(
        { _id: update.unitId, organization: org._id, active: true },
        { startBillingPeriod: update.startBillingPeriod }
      );
    }
    for (const update of debtUpdates) {
      await Unit.updateOne(
        { _id: update.unitId, organization: org._id, active: true },
        { balance: update.balance, isDebtor: update.balance < 0 }
      );
    }
  }

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

run().catch(async err => {
  console.error(err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
