const crypto = require('crypto');
const PayrollRuleVersion = require('../models/PayrollRuleVersion');

// Obtiene la versión de reglas vigente para un período dado (YYYY-MM)
async function getActiveRuleVersion(period) {
  const periodStart = new Date(`${period}-01`);
  const version = await PayrollRuleVersion.findOne({
    country: 'AR',
    effectiveFrom: { $lte: periodStart },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: periodStart } }],
  }).sort({ effectiveFrom: -1 });
  return version || null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Calcula la liquidación mensual básica usando los datos del perfil y las reglas
async function calculateMonthly({ profile, payrollSetting, period, news = {} }) {
  const ruleVersion = await getActiveRuleVersion(period);
  if (!ruleVersion) {
    throw new Error(`No hay versión de reglas vigente para el período ${period}. Configure las reglas en /api/payroll/rules.`);
  }

  const rules = ruleVersion.rules;
  const baseSalaryForPeriod = getBaseSalaryForPeriod(profile, period);
  const workedDays = news.workedDays ?? 30;
  const totalDays = 30;

  const proportionalBase = round2(baseSalaryForPeriod * (workedDays / totalDays));

  const items = [];

  // ── Conceptos remunerativos ───────────────────────────────────
  items.push({
    code: 'BASICO',
    label: 'Sueldo básico proporcional',
    type: 'remunerative',
    quantity: workedDays,
    unitValue: round2(baseSalaryForPeriod / totalDays),
    amount: proportionalBase,
    formulaSnapshot: `baseSalary(${baseSalaryForPeriod}) × (${workedDays}/${totalDays})`,
    legalReference: 'LCT Art. 116 y ss.',
  });

  // Horas extra (placeholder — requiere validación profesional)
  const overtime = news.overtime || [];
  for (const ot of overtime) {
    const rate = ot.type === 'holiday' ? (rules.get?.('overtime_holiday_factor') ?? 2.0) : (rules.get?.('overtime_regular_factor') ?? 1.5);
    const dailyRate = round2(baseSalaryForPeriod / totalDays / 8);
    const amount = round2(ot.hours * dailyRate * rate);
    items.push({
      code: ot.type === 'holiday' ? 'HS_EXTRA_FERIADO' : 'HS_EXTRA',
      label: `Horas extra ${ot.type === 'holiday' ? 'en día feriado' : ''}`,
      type: 'remunerative',
      quantity: ot.hours,
      unitValue: round2(dailyRate * rate),
      amount,
      formulaSnapshot: `${ot.hours}h × (baseSalary/30/8) × ${rate}`,
      legalReference: 'LCT Art. 201',
    });
  }

  const grossRemunerative = round2(items.filter(i => i.type === 'remunerative').reduce((s, i) => s + i.amount, 0));

  // ── Aportes empleado (descuentos) ─────────────────────────────
  // NOTA: Estos porcentajes son PLACEHOLDERS. Deben ser validados por un contador
  // antes de usar en producción. Ver PayrollRuleVersion para valores configurables.
  const aportePct = {
    jubilacion:     rules.get?.('jubilacion_empleado')  ?? 0.11,
    obraSocial:     rules.get?.('obra_social_empleado') ?? 0.03,
    anssal:         rules.get?.('anssal')               ?? 0.00045,
    ley19032:       rules.get?.('ley19032_empleado')    ?? 0.03,
    sindical:       rules.get?.('sindical')             ?? 0,
  };

  const deductions = [
    { code: 'AP_JUBILACION',  label: 'Aporte jubilación (11%)',   pct: aportePct.jubilacion,  ref: 'Ley 24241 Art. 11' },
    { code: 'AP_OBRA_SOCIAL', label: 'Aporte obra social (3%)',   pct: aportePct.obraSocial,  ref: 'Ley 23660' },
    { code: 'AP_ANSSAL',      label: 'ANSSAL (0,045%)',           pct: aportePct.anssal,       ref: 'Ley 23661' },
    { code: 'AP_LEY19032',    label: 'Ley 19.032 PAMI (3%)',      pct: aportePct.ley19032,    ref: 'Ley 19032' },
  ];
  if (aportePct.sindical > 0) {
    deductions.push({ code: 'AP_SINDICAL', label: 'Aporte sindical', pct: aportePct.sindical, ref: 'CCT' });
  }

  for (const d of deductions) {
    if (d.pct === 0) continue;
    const amount = round2(grossRemunerative * d.pct);
    items.push({
      code: d.code,
      label: d.label,
      type: 'deduction',
      quantity: 1,
      unitValue: d.pct,
      amount,
      formulaSnapshot: `grossRemunerative(${grossRemunerative}) × ${d.pct}`,
      legalReference: d.ref,
    });
  }

  // Adelantos del período
  const advances = news.advances || [];
  for (const adv of advances) {
    items.push({
      code: 'ADELANTO',
      label: 'Adelanto de haberes',
      type: 'deduction',
      quantity: 1,
      unitValue: adv.amount,
      amount: adv.amount,
      formulaSnapshot: `adelanto registrado ${adv.date || ''}`,
      legalReference: '',
    });
  }

  // ── Contribuciones empleador ──────────────────────────────────
  const contribPct = {
    jubilacion:   rules.get?.('jubilacion_empleador')  ?? 0.1087,
    obraSocial:   rules.get?.('obra_social_empleador') ?? 0.06,
    ley19032:     rules.get?.('ley19032_empleador')    ?? 0.02,
    asignaciones: rules.get?.('asignaciones_familiares') ?? 0.0590,
    art:          rules.get?.('art')                   ?? 0,
  };

  const contribs = [
    { code: 'CO_JUBILACION',   label: 'Contrib. jubilación (10,87%)',       pct: contribPct.jubilacion,   ref: 'Ley 24241' },
    { code: 'CO_OBRA_SOCIAL',  label: 'Contrib. obra social (6%)',          pct: contribPct.obraSocial,   ref: 'Ley 23660' },
    { code: 'CO_LEY19032',     label: 'Contrib. Ley 19.032 PAMI (2%)',      pct: contribPct.ley19032,     ref: 'Ley 19032' },
    { code: 'CO_ASIG_FAM',     label: 'Contrib. asignaciones familiares (5,90%)', pct: contribPct.asignaciones, ref: 'Ley 24714' },
  ];
  if (contribPct.art > 0) {
    contribs.push({ code: 'CO_ART', label: 'ART', pct: contribPct.art, ref: 'Ley 24557' });
  }

  for (const c of contribs) {
    if (c.pct === 0) continue;
    const amount = round2(grossRemunerative * c.pct);
    items.push({
      code: c.code,
      label: c.label,
      type: 'employer_contribution',
      quantity: 1,
      unitValue: c.pct,
      amount,
      formulaSnapshot: `grossRemunerative(${grossRemunerative}) × ${c.pct}`,
      legalReference: c.ref,
    });
  }

  // ── Totales ───────────────────────────────────────────────────
  const grossNonRemunerative = round2(items.filter(i => i.type === 'non_remunerative').reduce((s, i) => s + i.amount, 0));
  const deductionsTotal = round2(items.filter(i => i.type === 'deduction').reduce((s, i) => s + i.amount, 0));
  const employerContributionsTotal = round2(items.filter(i => i.type === 'employer_contribution').reduce((s, i) => s + i.amount, 0));
  const netPay = round2(grossRemunerative + grossNonRemunerative - deductionsTotal);

  const inputsHash = crypto.createHash('sha256')
    .update(JSON.stringify({ profile: profile._id, period, news, ruleVersion: ruleVersion.version }))
    .digest('hex');

  return {
    ruleVersion: ruleVersion.version,
    grossRemunerative,
    grossNonRemunerative,
    deductionsTotal,
    employerContributionsTotal,
    netPay,
    itemsSnapshot: items,
    warnings: [
      'BORRADOR — Los porcentajes de aportes y contribuciones son valores de referencia y deben ser validados por un contador o liquidador habilitado antes de considerarse oficiales.',
    ],
    audit: {
      inputsHash,
      calculatedAt: new Date().toISOString(),
      engineVersion: 'internal-v1',
    },
  };
}

// Obtiene el sueldo básico vigente para un período dado
function getBaseSalaryForPeriod(profile, period) {
  const periodStart = new Date(`${period}-01`);
  const history = (profile.baseSalaryHistory || [])
    .filter(h => new Date(h.effectiveFrom) <= periodStart)
    .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom));
  return history.length > 0 ? history[0].amount : profile.baseSalary;
}

module.exports = {
  getActiveRuleVersion,
  calculateMonthly,
  getBaseSalaryForPeriod,
};
