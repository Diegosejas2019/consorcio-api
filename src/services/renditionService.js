const puppeteer          = require('puppeteer');
const { cloudinary }     = require('./cloudinaryService');
const Payment            = require('../models/Payment');
const Expense            = require('../models/Expense');
const Organization       = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Unit               = require('../models/Unit');
const UnidentifiedPayment = require('../models/UnidentifiedPayment');
const MonthlyRendition   = require('../models/MonthlyRendition');
const delinquencyService = require('./delinquencyService');
const { getExpenseCategoryLabelMap, listExpenseCategories } = require('./expenseCategoryService');
const logger             = require('../config/logger');

// ── Helpers de formato ────────────────────────────────────────────────────────

const fmtARS = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n ?? 0);

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('es-AR') : '—';

const fmtPeriod = (yyyymm) => {
  if (!yyyymm) return '—';
  const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const [y, m] = yyyymm.split('-');
  return `${months[parseInt(m, 10) - 1]} ${y}`;
};

// ── Utilidades de período ─────────────────────────────────────────────────────

function periodDateRange(period) {
  const [year, mon] = period.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, mon - 1, 1)),
    end:   new Date(Date.UTC(year, mon,     1)),
  };
}

// ── PREVIEW: datos consolidados del período ───────────────────────────────────

async function buildRenditionPreview(orgId, period) {
  const { start, end } = periodDateRange(period);

  const [
    org,
    incomeAgg,
    prevIncomeAgg,
    prevExpensesAgg,
    expensesByCategory,
    allPeriodPayments,
    unidentifiedPending,
    delinquencySummary,
    existingRendition,
    categoryList,
    activeOwnersCount,
  ] = await Promise.all([
    Organization.findById(orgId)
      .select('name businessType monthlyFee feeLabel memberLabel unitLabel dueDayOfMonth bankName bankCbu bankAccount bankHolder feePeriodCode lateFeePercent')
      .lean(),

    // Ingresos aprobados del período
    Payment.aggregate([
      { $match: { organization: orgId, status: 'approved', month: period } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),

    // Ingresos aprobados de períodos anteriores (para saldo anterior)
    Payment.aggregate([
      { $match: { organization: orgId, status: 'approved', month: { $lt: period } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),

    // Gastos anteriores al período (para saldo anterior)
    Expense.aggregate([
      { $match: { organization: orgId, isActive: { $ne: false }, date: { $lt: start } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),

    // Gastos del período por categoría y tipo
    Expense.aggregate([
      { $match: { organization: orgId, isActive: { $ne: false }, date: { $gte: start, $lt: end } } },
      { $group: { _id: { category: '$category', type: '$expenseType' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),

    // Pagos del período por estado
    Payment.find({ organization: orgId, month: period })
      .populate('owner', 'name email')
      .select('owner amount status type paymentMethod createdAt month breakdown')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean(),

    // Pagos no identificados pendientes
    UnidentifiedPayment.countDocuments({ organization: orgId, status: 'pending' }),

    // Resumen de morosidad (global de la org)
    delinquencyService.getOrganizationDelinquencySummary(orgId),

    // Rendición existente para el período
    MonthlyRendition.findOne({ organization: orgId, period }).sort({ version: -1 }).lean(),

    // Categorías para labels
    listExpenseCategories(orgId),

    // Propietarios activos
    OrganizationMember.countDocuments({ organization: orgId, role: 'owner', isActive: true }),
  ]);

  const income        = incomeAgg[0]?.total || 0;
  const incomeCount   = incomeAgg[0]?.count || 0;
  const saldoAnterior = (prevIncomeAgg[0]?.total || 0) - (prevExpensesAgg[0]?.total || 0);

  const labelMap      = Object.fromEntries(categoryList.map(c => [c.key, c.label]));

  // Totales de gastos
  let ordinaryTotal = 0, extraordinaryTotal = 0;
  const byCategoryMap = {};
  expensesByCategory.forEach(({ _id, total }) => {
    if (_id.type === 'ordinary')       ordinaryTotal      += total;
    if (_id.type === 'extraordinary')  extraordinaryTotal += total;
    if (!byCategoryMap[_id.category]) byCategoryMap[_id.category] = { ordinary: 0, extraordinary: 0 };
    byCategoryMap[_id.category][_id.type === 'ordinary' ? 'ordinary' : 'extraordinary'] += total;
  });
  const expTotal = ordinaryTotal + extraordinaryTotal;
  const balance  = saldoAnterior + income - expTotal;

  // Pagos por estado
  const approvedPayments = allPeriodPayments.filter(p => p.status === 'approved');
  const pendingPayments  = allPeriodPayments.filter(p => p.status === 'pending');
  const rejectedPayments = allPeriodPayments.filter(p => p.status === 'rejected');

  const warnings = await buildRenditionWarnings(orgId, period, {
    pendingPaymentsCount: pendingPayments.length,
    unidentifiedPending,
    existingRendition,
  });

  return {
    org: {
      name:        org?.name || '—',
      feeLabel:    org?.feeLabel || 'Expensas',
      memberLabel: org?.memberLabel || 'Propietario',
      unitLabel:   org?.unitLabel || 'Unidad',
    },
    period,
    periodLabel: fmtPeriod(period),
    generatedAt: new Date().toISOString(),
    activeOwners: activeOwnersCount,

    summary: {
      saldoAnterior,
      income,
      incomeCount,
      expTotal,
      ordinaryTotal,
      extraordinaryTotal,
      balance,
      pendingTotal:  pendingPayments.reduce((s, p) => s + p.amount, 0),
      pendingCount:  pendingPayments.length,
      rejectedTotal: rejectedPayments.reduce((s, p) => s + p.amount, 0),
    },

    expenses: {
      byCategory: byCategoryMap,
      categoryLabels: labelMap,
      ordinaryTotal,
      extraordinaryTotal,
      total: expTotal,
    },

    payments: {
      approved:  approvedPayments.map(p => ({
        date:    p.createdAt,
        owner:   p.owner?.name || '—',
        amount:  p.amount,
        method:  p.paymentMethod,
        period:  p.month,
      })),
      pending:   pendingPayments.map(p => ({
        date:   p.createdAt,
        owner:  p.owner?.name || '—',
        amount: p.amount,
        method: p.paymentMethod,
        period: p.month,
      })),
      rejected:  rejectedPayments.map(p => ({
        date:   p.createdAt,
        owner:  p.owner?.name || '—',
        amount: p.amount,
      })),
    },

    delinquency: {
      totalDebt:        delinquencySummary.totalDebt,
      delinquentOwners: delinquencySummary.delinquentOwners,
      totalOwners:      delinquencySummary.totalOwners,
      delinquencyRate:  delinquencySummary.delinquencyRate,
      oldestDebtPeriod: delinquencySummary.oldestDebtPeriod,
      criticalOwners:   delinquencySummary.criticalOwners,
      pendingPaymentsCount:  delinquencySummary.pendingPaymentsCount,
      pendingPaymentsAmount: delinquencySummary.pendingPaymentsAmount,
    },

    unidentifiedPendingCount: unidentifiedPending,

    observations: existingRendition?.observations || '',
    existingRendition: existingRendition
      ? { id: existingRendition._id, pdfUrl: existingRendition.pdfUrl, status: existingRendition.status, version: existingRendition.version, generatedAt: existingRendition.generatedAt }
      : null,

    warnings,
  };
}

// ── ADVERTENCIAS ─────────────────────────────────────────────────────────────

async function buildRenditionWarnings(orgId, period, data = {}) {
  const warnings = [];

  if (data.pendingPaymentsCount > 0) {
    warnings.push({
      code: 'PENDING_PAYMENTS',
      message: `Hay ${data.pendingPaymentsCount} pago(s) pendientes de aprobación para este período.`,
      severity: 'warning',
    });
  }

  if (data.unidentifiedPending > 0) {
    warnings.push({
      code: 'UNIDENTIFIED_PAYMENTS',
      message: `Hay ${data.unidentifiedPending} pago(s) no identificado(s) sin asociar.`,
      severity: 'warning',
    });
  }

  if (data.existingRendition) {
    warnings.push({
      code: 'EXISTING_RENDITION',
      message: `Ya existe una rendición generada para ${fmtPeriod(period)} (versión ${data.existingRendition.version}).`,
      severity: 'info',
    });
  }

  // Gastos sin comprobante del período
  const { start, end } = periodDateRange(period);
  const expensesWithoutInvoice = await Expense.countDocuments({
    organization: orgId,
    isActive: { $ne: false },
    date: { $gte: start, $lt: end },
    $or: [{ invoiceNumber: { $exists: false } }, { invoiceNumber: null }, { invoiceNumber: '' }],
  });
  if (expensesWithoutInvoice > 0) {
    warnings.push({
      code: 'EXPENSES_WITHOUT_INVOICE',
      message: `Hay ${expensesWithoutInvoice} gasto(s) sin número de comprobante en este período.`,
      severity: 'info',
    });
  }

  // Propietarios sin unidad asignada
  const memberUserIds = await OrganizationMember.find({ organization: orgId, role: 'owner', isActive: true })
    .distinct('user');
  const usersWithUnit = await Unit.find({ organization: orgId, active: true, owner: { $in: memberUserIds } })
    .distinct('owner');
  const ownersWithoutUnit = memberUserIds.length - usersWithUnit.length;
  if (ownersWithoutUnit > 0) {
    warnings.push({
      code: 'OWNERS_WITHOUT_UNIT',
      message: `Hay ${ownersWithoutUnit} propietario(s) sin unidad asignada.`,
      severity: 'warning',
    });
  }

  return warnings;
}

// ── GUARDAR OBSERVACIONES ─────────────────────────────────────────────────────

async function saveObservations(orgId, period, observations, userId) {
  const sanitized = (observations || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim().slice(0, 4000);
  const doc = await MonthlyRendition.findOneAndUpdate(
    { organization: orgId, period },
    {
      $set: {
        observations: sanitized,
        organization: orgId,
        period,
        generatedBy: userId,
      },
    },
    { upsert: true, new: true, sort: { version: -1 } }
  );
  return doc;
}

// ── HISTORIAL ─────────────────────────────────────────────────────────────────

async function getRenditionHistory(orgId) {
  return MonthlyRendition.find({ organization: orgId })
    .sort({ period: -1, version: -1 })
    .select('period generatedAt generatedBy observations pdfUrl status version warnings')
    .populate('generatedBy', 'name')
    .lean();
}

// ── PDF PROFESIONAL ───────────────────────────────────────────────────────────

function buildRenditionHTML(preview) {
  const { org, period, periodLabel, generatedAt, summary, expenses, payments, delinquency, observations, warnings } = preview;

  const warnRows = warnings.length > 0
    ? warnings.map(w => `
      <tr>
        <td style="padding:6px 10px;font-size:12px;color:${w.severity === 'critical' ? '#dc2626' : w.severity === 'warning' ? '#d97706' : '#374151'};">
          ${w.severity === 'critical' ? '⚠️' : w.severity === 'warning' ? '⚠' : 'ℹ'} ${w.message}
        </td>
      </tr>`).join('')
    : `<tr><td style="padding:6px 10px;font-size:12px;color:#6b7280;">Sin advertencias.</td></tr>`;

  const approvedRows = payments.approved.length > 0
    ? payments.approved.map((p, i) => `
      <tr style="background:${i % 2 === 0 ? '#fff' : '#f9fafb'};border-bottom:1px solid #f3f4f6;">
        <td style="padding:7px 10px;font-size:12px;color:#374151;">${fmtDate(p.date)}</td>
        <td style="padding:7px 10px;font-size:12px;color:#374151;">${p.owner}</td>
        <td style="padding:7px 10px;font-size:12px;color:#374151;text-align:right;">${fmtARS(p.amount)}</td>
        <td style="padding:7px 10px;font-size:12px;color:#374151;">${p.method === 'mercadopago' ? 'MercadoPago' : 'Manual'}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" style="padding:10px;font-size:12px;color:#9ca3af;text-align:center;">Sin pagos aprobados.</td></tr>`;

  const pendingRows = payments.pending.length > 0
    ? payments.pending.map((p, i) => `
      <tr style="background:${i % 2 === 0 ? '#fffbeb' : '#fef3c7'};border-bottom:1px solid #fde68a;">
        <td style="padding:7px 10px;font-size:12px;color:#92400e;">${fmtDate(p.date)}</td>
        <td style="padding:7px 10px;font-size:12px;color:#92400e;">${p.owner}</td>
        <td style="padding:7px 10px;font-size:12px;color:#92400e;text-align:right;">${fmtARS(p.amount)}</td>
        <td style="padding:7px 10px;font-size:12px;color:#92400e;">Pendiente aprobación</td>
      </tr>`).join('')
    : `<tr><td colspan="4" style="padding:10px;font-size:12px;color:#9ca3af;text-align:center;">Sin pagos pendientes.</td></tr>`;

  const catRows = Object.entries(expenses.categoryLabels).map(([key, label]) => {
    const cat = expenses.byCategory[key];
    if (!cat) return '';
    const total = (cat.ordinary || 0) + (cat.extraordinary || 0);
    if (total === 0) return '';
    return `
      <tr style="border-bottom:1px solid #f3f4f6;">
        <td style="padding:7px 10px;font-size:12px;color:#374151;">${label}</td>
        <td style="padding:7px 10px;font-size:12px;color:#374151;text-align:right;">${fmtARS(cat.ordinary || 0)}</td>
        <td style="padding:7px 10px;font-size:12px;color:#374151;text-align:right;">${fmtARS(cat.extraordinary || 0)}</td>
        <td style="padding:7px 10px;font-size:12px;font-weight:600;color:#111827;text-align:right;">${fmtARS(total)}</td>
      </tr>`;
  }).join('');

  const obsSection = observations
    ? `<div style="margin-top:24px;padding:16px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;">
        <div style="font-size:12px;font-weight:700;color:#1a1a2e;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Observaciones del administrador</div>
        <p style="font-size:13px;color:#374151;white-space:pre-wrap;margin:0;">${observations}</p>
       </div>`
    : '';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Rendición Mensual — ${periodLabel}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #fff; color: #374151; padding: 32px; }
  h1 { font-size: 22px; font-weight: 700; color: #1a1a2e; }
  h2 { font-size: 14px; font-weight: 700; color: #1a1a2e; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; margin-top: 24px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  th { background: #1a1a2e; color: #d1d5db; padding: 8px 10px; font-size: 11px; text-align: left; }
  .sum-card { display: inline-block; text-align: center; padding: 12px 18px; border: 1px solid #e5e7eb; border-radius: 8px; margin: 4px; min-width: 130px; vertical-align: top; }
  .sum-label { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: .5px; }
  .sum-value { font-size: 16px; font-weight: 700; color: #1a1a2e; margin-top: 4px; }
  .sum-value.red { color: #dc2626; }
  .sum-value.green { color: #16a34a; }
  .page-break { page-break-before: always; }
</style></head><body>

<!-- ENCABEZADO -->
<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a1a2e;padding-bottom:16px;margin-bottom:20px;">
  <div>
    <h1>${org.name}</h1>
    <div style="font-size:13px;color:#6b7280;margin-top:4px;">Rendición Mensual Profesional</div>
    <div style="font-size:15px;font-weight:700;color:#1a1a2e;margin-top:6px;">${periodLabel}</div>
  </div>
  <div style="text-align:right;font-size:12px;color:#6b7280;">
    Emitido: ${fmtDate(generatedAt)}<br>
    Tipo: ${org.feeLabel || 'Expensas'}
  </div>
</div>

<!-- RESUMEN EJECUTIVO -->
<h2>Resumen ejecutivo</h2>
<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:16px;">
  <div class="sum-card"><div class="sum-label">Saldo anterior</div><div class="sum-value ${summary.saldoAnterior < 0 ? 'red' : ''}">${fmtARS(summary.saldoAnterior)}</div></div>
  <div class="sum-card"><div class="sum-label">Ingresos cobrados</div><div class="sum-value green">${fmtARS(summary.income)}</div></div>
  <div class="sum-card"><div class="sum-label">Total gastos</div><div class="sum-value red">${fmtARS(summary.expTotal)}</div></div>
  <div class="sum-card"><div class="sum-label">Balance</div><div class="sum-value ${summary.balance < 0 ? 'red' : 'green'}">${fmtARS(summary.balance)}</div></div>
  <div class="sum-card"><div class="sum-label">Gastos ordinarios</div><div class="sum-value">${fmtARS(summary.ordinaryTotal)}</div></div>
  <div class="sum-card"><div class="sum-label">Gastos extraordinarios</div><div class="sum-value">${fmtARS(summary.extraordinaryTotal)}</div></div>
  <div class="sum-card"><div class="sum-label">Pagos pendientes</div><div class="sum-value ${summary.pendingCount > 0 ? 'red' : ''}">${summary.pendingCount} (${fmtARS(summary.pendingTotal)})</div></div>
  <div class="sum-card"><div class="sum-label">Morosidad</div><div class="sum-value ${delinquency.delinquencyRate > 0 ? 'red' : 'green'}">${delinquency.delinquencyRate}%</div></div>
  <div class="sum-card"><div class="sum-label">Deuda total</div><div class="sum-value ${delinquency.totalDebt > 0 ? 'red' : ''}">${fmtARS(delinquency.totalDebt)}</div></div>
</div>

<!-- ADVERTENCIAS -->
${warnings.length > 0 ? `
<h2 style="color:#b45309;">Advertencias</h2>
<table style="margin-bottom:16px;"><tbody>${warnRows}</tbody></table>` : ''}

<!-- GASTOS -->
<h2>Egresos / Gastos del período</h2>
<table>
  <thead><tr>
    <th>Categoría</th>
    <th style="text-align:right;">Ordinarios</th>
    <th style="text-align:right;">Extraordinarios</th>
    <th style="text-align:right;">Total</th>
  </tr></thead>
  <tbody>
    ${catRows || '<tr><td colspan="4" style="padding:10px;font-size:12px;color:#9ca3af;text-align:center;">Sin gastos registrados.</td></tr>'}
    <tr style="background:#f3f4f6;border-top:2px solid #1a1a2e;font-weight:700;">
      <td style="padding:8px 10px;font-size:13px;color:#1a1a2e;">TOTAL</td>
      <td style="padding:8px 10px;font-size:13px;color:#1a1a2e;text-align:right;">${fmtARS(summary.ordinaryTotal)}</td>
      <td style="padding:8px 10px;font-size:13px;color:#1a1a2e;text-align:right;">${fmtARS(summary.extraordinaryTotal)}</td>
      <td style="padding:8px 10px;font-size:14px;font-weight:700;color:#1a1a2e;text-align:right;">${fmtARS(summary.expTotal)}</td>
    </tr>
  </tbody>
</table>

<!-- INGRESOS APROBADOS -->
<h2>Ingresos — Pagos aprobados</h2>
<table>
  <thead><tr>
    <th>Fecha</th><th>Propietario</th><th style="text-align:right;">Importe</th><th>Medio</th>
  </tr></thead>
  <tbody>${approvedRows}</tbody>
</table>

<!-- PAGOS PENDIENTES -->
${payments.pending.length > 0 ? `
<h2 style="color:#b45309;">Pagos pendientes de aprobación</h2>
<table>
  <thead><tr style="background:#92400e;">
    <th>Fecha</th><th>Propietario</th><th style="text-align:right;">Importe</th><th>Estado</th>
  </tr></thead>
  <tbody>${pendingRows}</tbody>
</table>` : ''}

<!-- MOROSIDAD -->
<h2>Deuda y morosidad (estado actual de la organización)</h2>
<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:16px;">
  <div class="sum-card"><div class="sum-label">Propietarios morosos</div><div class="sum-value ${delinquency.delinquentOwners > 0 ? 'red' : 'green'}">${delinquency.delinquentOwners} / ${delinquency.totalOwners}</div></div>
  <div class="sum-card"><div class="sum-label">Deuda total</div><div class="sum-value ${delinquency.totalDebt > 0 ? 'red' : ''}">${fmtARS(delinquency.totalDebt)}</div></div>
  <div class="sum-card"><div class="sum-label">Tasa morosidad</div><div class="sum-value ${delinquency.delinquencyRate > 0 ? 'red' : 'green'}">${delinquency.delinquencyRate}%</div></div>
  <div class="sum-card"><div class="sum-label">Mora crítica</div><div class="sum-value ${delinquency.criticalOwners > 0 ? 'red' : ''}">${delinquency.criticalOwners}</div></div>
  <div class="sum-card"><div class="sum-label">Período más antiguo</div><div class="sum-value">${delinquency.oldestDebtPeriod ? fmtPeriod(delinquency.oldestDebtPeriod) : '—'}</div></div>
</div>

${obsSection}

<p style="margin-top:32px;font-size:10px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:8px;">
  Documento generado por GestionAr el ${fmtDate(generatedAt)} | Los importes están en pesos argentinos (ARS) | Este reporte es informativo y no reemplaza documentación contable oficial.
</p>
</body></html>`;
}

// ── GENERAR PDF Y GUARDAR ─────────────────────────────────────────────────────

async function generatePDF(html) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '0', bottom: '20px', left: '0' },
    });
    return buffer;
  } finally {
    await browser.close();
  }
}

async function uploadRenditionPdf(buffer, orgId, period) {
  const b64     = Buffer.from(buffer).toString('base64');
  const dataUri = `data:application/pdf;base64,${b64}`;
  const publicId = `rendicion_${orgId}_${period}_${Date.now()}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    folder:        'consorcio/rendiciones',
    resource_type: 'raw',
    public_id:     publicId,
    format:        'pdf',
    type:          'upload',
  });

  return { url: result.secure_url, publicId: result.public_id };
}

async function generateEnhancedPdf(orgId, period, userId) {
  const preview = await buildRenditionPreview(orgId, period);
  const html    = buildRenditionHTML(preview);
  const buffer  = await generatePDF(html);
  const { url, publicId } = await uploadRenditionPdf(buffer, orgId, period);

  // Buscar rendición existente para versionar
  const last = await MonthlyRendition.findOne({ organization: orgId, period }).sort({ version: -1 }).lean();
  const nextVersion = last ? last.version + 1 : 1;

  const rendition = await MonthlyRendition.findOneAndUpdate(
    { organization: orgId, period, version: nextVersion },
    {
      organization: orgId,
      period,
      generatedAt: new Date(),
      generatedBy: userId,
      pdfUrl: url,
      pdfPublicId: publicId,
      status: 'generated',
      version: nextVersion,
      warnings: preview.warnings,
      observations: last?.observations || '',
    },
    { upsert: true, new: true }
  );

  logger.info(`[renditionService] PDF generado para org=${orgId} period=${period} v=${nextVersion}`);
  return { rendition, pdfUrl: url };
}

// ── EXPORTAR CSV ──────────────────────────────────────────────────────────────

function toCsvRow(fields) {
  return fields.map(f => {
    const v = (f == null ? '' : String(f)).replace(/"/g, '""');
    return `"${v}"`;
  }).join(',');
}

function buildCsv(headers, rows) {
  const BOM = '﻿';
  return BOM + [headers, ...rows].map(r => toCsvRow(r)).join('\r\n');
}

async function exportRenditionCsv(orgId, period, section) {
  const preview = await buildRenditionPreview(orgId, period);

  if (section === 'resumen') {
    const { summary, delinquency, periodLabel } = preview;
    const rows = [
      ['Concepto', 'Importe (ARS)'],
      ['Período', periodLabel],
      ['Saldo anterior', summary.saldoAnterior],
      ['Ingresos (pagos aprobados)', summary.income],
      ['Gastos ordinarios', summary.ordinaryTotal],
      ['Gastos extraordinarios', summary.extraordinaryTotal],
      ['Total gastos', summary.expTotal],
      ['Balance', summary.balance],
      ['Pagos pendientes aprobación', summary.pendingTotal],
      ['Pagos pendientes (#)', summary.pendingCount],
      ['Deuda total', delinquency.totalDebt],
      ['Propietarios morosos', delinquency.delinquentOwners],
      ['Tasa morosidad (%)', delinquency.delinquencyRate],
    ];
    return buildCsv(rows[0], rows.slice(1));
  }

  if (section === 'gastos') {
    const { expenses } = preview;
    const { start, end } = periodDateRange(period);
    const expList = await Expense.find({
      organization: orgId,
      isActive: { $ne: false },
      date: { $gte: start, $lt: end },
    })
      .populate('provider', 'name cuit')
      .select('date description category expenseType amount invoiceNumber invoiceCuit provider status')
      .sort({ date: 1 })
      .lean();

    const headers = ['Fecha', 'Descripción', 'Categoría', 'Tipo', 'Proveedor', 'N° Factura', 'Importe (ARS)', 'Estado'];
    const rows = expList.map(e => [
      fmtDate(e.date),
      e.description,
      expenses.categoryLabels[e.category] || e.category,
      e.expenseType === 'ordinary' ? 'Ordinario' : 'Extraordinario',
      e.provider?.name || '—',
      e.invoiceNumber || '—',
      e.amount,
      e.status === 'paid' ? 'Pagado' : 'Pendiente',
    ]);
    return buildCsv(headers, rows);
  }

  if (section === 'pagos') {
    const { payments } = preview;
    const headers = ['Fecha', 'Propietario', 'Estado', 'Importe (ARS)', 'Medio de pago'];
    const allPayments = [
      ...payments.approved.map(p => [fmtDate(p.date), p.owner, 'Aprobado', p.amount, p.method === 'mercadopago' ? 'MercadoPago' : 'Manual']),
      ...payments.pending.map(p  => [fmtDate(p.date), p.owner, 'Pendiente', p.amount, p.method === 'mercadopago' ? 'MercadoPago' : 'Manual']),
      ...payments.rejected.map(p => [fmtDate(p.date), p.owner, 'Rechazado', p.amount, '—']),
    ];
    return buildCsv(headers, allPayments);
  }

  if (section === 'morosidad') {
    const rows = await delinquencyService.buildDelinquencyRows(orgId);
    const debtors = rows.filter(r => r.totalOwed > 0);
    const headers = ['Propietario', 'Email', 'Unidades', 'Deuda total (ARS)', 'Períodos adeudados', 'Período más antiguo', 'Estado'];
    const csvRows = debtors.map(r => [
      r.name,
      r.email,
      (r.units || []).join(', '),
      r.totalOwed,
      r.unpaidPeriods,
      r.oldestPeriod ? fmtPeriod(r.oldestPeriod) : '—',
      r.status || '—',
    ]);
    return buildCsv(headers, csvRows);
  }

  throw Object.assign(new Error('Sección de exportación inválida.'), { statusCode: 400 });
}

// ── RENDICIÓN ANUAL ───────────────────────────────────────────────────────────

async function buildAnnualRendition(orgId, year) {
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, '0');
    return `${year}-${m}`;
  });

  const yearStart = new Date(Date.UTC(Number(year), 0, 1));
  const yearEnd   = new Date(Date.UTC(Number(year) + 1, 0, 1));

  // Datos compartidos para todo el año — 3 queries en lugar de N por mes
  const [categoryList, expByCatAgg, payCountsAgg] = await Promise.all([
    listExpenseCategories(orgId),
    Expense.aggregate([
      { $match: { organization: orgId, isActive: { $ne: false }, date: { $gte: yearStart, $lt: yearEnd } } },
      { $group: { _id: { month: { $dateToString: { format: '%Y-%m', date: '$date' } }, category: '$category' }, total: { $sum: '$amount' } } },
    ]),
    Payment.aggregate([
      { $match: { organization: orgId, month: { $gte: `${year}-01`, $lte: `${year}-12` } } },
      { $group: { _id: { month: '$month', status: '$status' }, count: { $sum: 1 } } },
    ]),
  ]);

  const labelMap = Object.fromEntries(categoryList.map(c => [c.key, c.label]));

  const expByCatByMonth = {};
  expByCatAgg.forEach(({ _id, total }) => {
    if (!expByCatByMonth[_id.month]) expByCatByMonth[_id.month] = {};
    expByCatByMonth[_id.month][_id.category] = (expByCatByMonth[_id.month][_id.category] || 0) + total;
  });

  const payCountsByMonth = {};
  payCountsAgg.forEach(({ _id, count }) => {
    if (!payCountsByMonth[_id.month]) payCountsByMonth[_id.month] = {};
    payCountsByMonth[_id.month][_id.status] = count;
  });

  const rows = await Promise.all(months.map(async (period) => {
    try {
      const { start, end } = periodDateRange(period);

      const [incomeAgg, expensesAgg] = await Promise.all([
        Payment.aggregate([
          { $match: { organization: orgId, status: 'approved', month: period } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
        Expense.aggregate([
          { $match: { organization: orgId, isActive: { $ne: false }, date: { $gte: start, $lt: end } } },
          { $group: { _id: '$expenseType', total: { $sum: '$amount' } } },
        ]),
      ]);

      const income = incomeAgg[0]?.total || 0;
      const expMap = Object.fromEntries(expensesAgg.map(e => [e._id, e.total]));
      const ordinaryTotal      = expMap.ordinary      || 0;
      const extraordinaryTotal = expMap.extraordinary || 0;
      const expTotal = ordinaryTotal + extraordinaryTotal;

      const pendingAgg = await Payment.aggregate([
        { $match: { organization: orgId, status: 'pending', month: period } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      const pendingTotal = pendingAgg[0]?.total || 0;

      const savedRendition = await MonthlyRendition.findOne({ organization: orgId, period })
        .sort({ version: -1 })
        .select('generatedAt status pdfUrl')
        .lean();

      // Categorías de gasto del mes (datos precargados en bulk)
      const monthCats = expByCatByMonth[period] || {};
      const expenseByCategory = Object.entries(monthCats)
        .map(([key, amount]) => ({ key, label: labelMap[key] || key, amount }))
        .filter(c => c.amount > 0)
        .sort((a, b) => b.amount - a.amount);

      // Conteos de pagos del mes (datos precargados en bulk)
      const monthPays = payCountsByMonth[period] || {};

      return {
        period,
        periodLabel:           fmtPeriod(period),
        income,
        pendingTotal,
        ordinaryTotal,
        extraordinaryTotal,
        expTotal,
        resultado:             income - expTotal,
        hasSavedRendition:     !!savedRendition,
        savedPdfUrl:           savedRendition?.pdfUrl || null,
        status:                savedRendition?.status || 'sin-rendición',
        approvedPaymentsCount: monthPays.approved || 0,
        pendingPaymentsCount:  monthPays.pending  || 0,
        expenseByCategory,
      };
    } catch (err) {
      logger.warn(`[renditionService] Error en período ${period} del año ${year}: ${err.message}`);
      return {
        period,
        periodLabel: fmtPeriod(period),
        error: 'Error al calcular este período.',
      };
    }
  }));

  const validRows = rows.filter(r => !r.error);
  const activeMonths = Math.max(validRows.filter(r => r.income > 0 || r.expTotal > 0).length, 1);

  const warnings = [];
  const missingRenditions = validRows.filter(r => !r.hasSavedRendition).length;
  if (missingRenditions > 0) {
    warnings.push({
      code: 'MISSING_MONTHLY_RENDITIONS',
      message: `${missingRenditions} mes(es) del año ${year} no tienen rendición mensual generada. Los datos se calculan dinámicamente.`,
      severity: 'info',
    });
  }

  const negativeMonths = validRows.filter(r => r.resultado < 0);
  if (negativeMonths.length > 0) {
    warnings.push({
      code: 'NEGATIVE_BALANCE_MONTHS',
      message: `${negativeMonths.length} mes(es) tuvieron saldo negativo: ${negativeMonths.map(r => r.periodLabel).join(', ')}.`,
      severity: 'warning',
    });
  }

  const pendingMonths = validRows.filter(r => r.pendingPaymentsCount > 0);
  if (pendingMonths.length > 0) {
    warnings.push({
      code: 'PENDING_PAYMENTS_MONTHS',
      message: `Pagos pendientes en ${pendingMonths.length} mes(es): ${pendingMonths.map(r => r.periodLabel).join(', ')}.`,
      severity: 'warning',
    });
  }

  const totals = validRows.reduce((acc, r) => {
    acc.income             += r.income || 0;
    acc.expTotal           += r.expTotal || 0;
    acc.ordinaryTotal      += r.ordinaryTotal || 0;
    acc.extraordinaryTotal += r.extraordinaryTotal || 0;
    acc.resultado          += r.resultado || 0;
    return acc;
  }, { income: 0, expTotal: 0, ordinaryTotal: 0, extraordinaryTotal: 0, resultado: 0 });

  const highestExpenseRow = validRows.reduce((best, r) => (!best || r.expTotal > best.expTotal) ? r : best, null);
  const highestIncomeRow  = validRows.reduce((best, r) => (!best || r.income  > best.income)   ? r : best, null);

  totals.averageMonthlyIncome   = Math.round(totals.income   / activeMonths);
  totals.averageMonthlyExpenses = Math.round(totals.expTotal / activeMonths);
  totals.highestExpenseMonth    = highestExpenseRow?.periodLabel || null;
  totals.highestIncomeMonth     = highestIncomeRow?.periodLabel  || null;
  totals.negativeBalanceMonths  = negativeMonths.length;
  totals.monthsWithRendition    = validRows.filter(r => r.hasSavedRendition).length;

  return { year, rows, totals, warnings };
}

module.exports = {
  buildRenditionPreview,
  buildRenditionWarnings,
  saveObservations,
  getRenditionHistory,
  generateEnhancedPdf,
  exportRenditionCsv,
  buildAnnualRendition,
};
