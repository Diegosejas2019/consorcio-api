const puppeteer          = require('puppeteer');
const Payment            = require('../models/Payment');
const Expense            = require('../models/Expense');
const Organization       = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Unit               = require('../models/Unit');
const logger             = require('../config/logger');
const {
  getExpenseCategoryLabelMap,
  listExpenseCategories,
} = require('../services/expenseCategoryService');

// ── GET /api/reports/monthly-summary?month=YYYY-MM ──────────────
exports.getMonthlySummary = async (req, res, next) => {
  try {
    const { month } = req.query;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({
        success: false,
        message: 'Parámetro month inválido. Formato esperado: YYYY-MM',
      });
    }

    const orgId = req.orgId;
    const [year, mon] = month.split('-').map(Number);
    const monthStart  = new Date(year, mon - 1, 1);
    const monthEnd    = new Date(year, mon, 0, 23, 59, 59, 999);

    logger.debug(`[reportController] monthly-summary org=${orgId} month=${month}`);

    const [incomeAgg, expensesAgg, prevIncomeAgg, prevExpensesAgg, categories] = await Promise.all([
      Payment.aggregate([
        { $match: { organization: orgId, status: 'approved', month } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Expense.aggregate([
        { $match: { organization: orgId, status: 'paid', isActive: { $ne: false }, date: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
      ]),
      Payment.aggregate([
        { $match: { organization: orgId, status: 'approved', month: { $lt: month } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Expense.aggregate([
        { $match: { organization: orgId, status: 'paid', isActive: { $ne: false }, date: { $lt: monthStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      listExpenseCategories(orgId, { createdBy: req.user?._id }),
    ]);

    const income        = incomeAgg[0]?.total        || 0;
    const saldoAnterior = (prevIncomeAgg[0]?.total   || 0) - (prevExpensesAgg[0]?.total || 0);

    const categoryKeys = [...new Set([...categories.map(c => c.key), ...expensesAgg.map(e => e._id)])];
    const expMap       = Object.fromEntries(expensesAgg.map(e => [e._id, e.total]));
    const expenses     = Object.fromEntries(categoryKeys.map(c => [c, expMap[c] || 0]));
    const expTotal     = categoryKeys.reduce((sum, c) => sum + expenses[c], 0);

    res.json({
      success: true,
      data: {
        month,
        saldoAnterior,
        income:   { expensas: income, total: income },
        expenses: { ...expenses, total: expTotal },
        balance:  saldoAnterior + income - expTotal,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Helpers PDF ───────────────────────────────────────────────

const formatCurrency = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n ?? 0);

const formatMonthLabel = (month) => {
  const [year, mon] = month.split('-').map(Number);
  return new Date(year, mon - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
};

const monthAbbrev = (month) => {
  const abbrevs = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  const [y, m] = month.split('-');
  return `${abbrevs[parseInt(m, 10) - 1]}.${y.slice(2)}`;
};

const buildExpensasHTML = (org, month, ordinary, extraordinary, owners, paymentsByOwner, categoryLabels = {}) => {
  const monthLabel = formatMonthLabel(month);
  const totalOrd   = ordinary.reduce((s, e) => s + e.amount, 0);
  const totalExt   = extraordinary.reduce((s, e) => s + e.amount, 0);
  const grandTotal = totalOrd + totalExt;

  // ── Sección 1: tabla de gastos ────────────────────────────────
  const renderRows = (items) => {
    if (!items.length) {
      return `<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:16px;">Sin gastos registrados</td></tr>`;
    }
    return items.map((e, i) => {
      const cuit    = e.invoiceCuit || e.provider?.cuit || '—';
      const invoice = e.invoiceNumber || '—';
      const prov    = e.provider?.name || '—';
      const rowBg   = i % 2 === 0 ? '#ffffff' : '#f9fafb';
      return `
        <tr style="background:${rowBg};border-bottom:1px solid #f3f4f6;">
          <td style="padding:10px 12px;font-size:13px;color:#374151;">${invoice}</td>
          <td style="padding:10px 12px;font-size:13px;color:#374151;">${cuit}</td>
          <td style="padding:10px 12px;font-size:13px;color:#374151;">${e.description}</td>
          <td style="padding:10px 12px;font-size:13px;color:#374151;">${prov}<br><span style="font-size:11px;color:#9ca3af;">${categoryLabels[e.category] || e.category}</span></td>
          <td style="padding:10px 12px;font-size:13px;color:#111827;text-align:right;font-weight:500;">${formatCurrency(e.amount)}</td>
        </tr>`;
    }).join('');
  };

  const sectionHeader = (title, color) => `
    <tr style="background:${color};">
      <th colspan="5" style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:700;color:#1a1a2e;">${title}</th>
    </tr>
    <tr style="background:#1a1a2e;">
      <th style="padding:10px 12px;font-size:11px;color:#d1d5db;text-align:left;">N° Factura</th>
      <th style="padding:10px 12px;font-size:11px;color:#d1d5db;text-align:left;">CUIT</th>
      <th style="padding:10px 12px;font-size:11px;color:#d1d5db;text-align:left;">Descripción</th>
      <th style="padding:10px 12px;font-size:11px;color:#d1d5db;text-align:left;">Proveedor / Cat.</th>
      <th style="padding:10px 12px;font-size:11px;color:#d1d5db;text-align:right;">Importe</th>
    </tr>`;

  const subtotalRow = (label, total, bg) => `
    <tr style="background:${bg};border-top:2px solid #1a1a2e;">
      <td colspan="4" style="padding:10px 12px;font-size:13px;font-weight:700;color:#1a1a2e;">${label}</td>
      <td style="padding:10px 12px;font-size:14px;font-weight:700;color:#1a1a2e;text-align:right;">${formatCurrency(total)}</td>
    </tr>`;

  // ── Sección 2: estado de cuentas y prorrateo ──────────────────
  const [year, mon] = month.split('-').map(Number);
  const dueDay      = org.dueDayOfMonth || 10;
  const dueDateStr  = `${String(dueDay).padStart(2,'0')}/${String(mon).padStart(2,'0')}/${year}`;
  const lateFee     = org.lateFeePercent || 0;
  const pagosHeader = monthAbbrev(month);

  let totalPagosMes       = 0;
  let totalSaldoDeudor    = 0;
  let totalSaldoAnterior  = 0;
  let totalExpensasProrr  = 0;
  let totalFinal          = 0;

  const ownerRows = owners.map((owner, idx) => {
    const ownerId       = owner._id.toString();
    const pagosMes      = paymentsByOwner[ownerId] || 0;
    const saldoAnterior = owner.balance + pagosMes;
    const saldoDeudor   = owner.balance; // estado actual tras pagos
    const pct           = owner.percentage || 0;
    const expProrr      = (pct / 100) * grandTotal;
    const total         = saldoDeudor + expProrr;

    totalSaldoAnterior += saldoAnterior;
    totalPagosMes      += pagosMes;
    totalSaldoDeudor   += saldoDeudor;
    totalExpensasProrr += expProrr;
    totalFinal         += total;

    const saldoColor    = saldoDeudor < 0 ? '#dc2626' : '#374151';
    const totalColor    = total < 0 ? '#dc2626' : (total === 0 ? '#6b7280' : '#111827');
    const rowBg         = idx % 2 === 0 ? '#ffffff' : '#f9fafb';

    return `
      <tr style="background:${rowBg};border-bottom:1px solid #f3f4f6;">
        <td style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:center;">${idx + 1}</td>
        <td style="padding:8px 10px;font-size:12px;color:#374151;font-weight:600;">${owner.unit || '—'}</td>
        <td style="padding:8px 10px;font-size:12px;color:#374151;">${owner.name}</td>
        <td style="padding:8px 10px;font-size:12px;color:#374151;text-align:right;">${formatCurrency(saldoAnterior)}</td>
        <td style="padding:8px 10px;font-size:12px;color:#374151;text-align:right;">${pagosMes > 0 ? formatCurrency(pagosMes) : '—'}</td>
        <td style="padding:8px 10px;font-size:12px;color:${saldoColor};text-align:right;font-weight:${saldoDeudor < 0 ? '600' : '400'};">${formatCurrency(saldoDeudor)}</td>
        <td style="padding:8px 10px;font-size:12px;color:#374151;text-align:center;">${pct > 0 ? pct.toFixed(2) + '%' : '—'}</td>
        <td style="padding:8px 10px;font-size:12px;color:#374151;text-align:right;">${pct > 0 ? formatCurrency(expProrr) : '—'}</td>
        <td style="padding:8px 10px;font-size:12px;color:${totalColor};text-align:right;font-weight:600;">${formatCurrency(total)}</td>
      </tr>`;
  }).join('');

  const estadoCuentasSection = owners.length > 0 ? `
  <!-- Estado de cuentas y prorrateo -->
  <div style="margin-top:32px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div style="font-size:14px;font-weight:700;color:#1a1a2e;text-transform:uppercase;letter-spacing:1px;">
        Estado de cuentas y prorrateo
      </div>
      <div style="font-size:11px;color:#6b7280;text-align:right;">
        Mes vencimiento: <strong style="color:#1a1a2e;text-transform:capitalize;">${monthLabel}</strong>
        &nbsp;|&nbsp; 1° vto: <strong style="color:#1a1a2e;">${dueDateStr}</strong>
        &nbsp;|&nbsp; Tasa de interés: <strong style="color:#1a1a2e;">${lateFee.toFixed(2)}%</strong>
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:#1a1a2e;">
          <th style="padding:8px 10px;color:#d1d5db;text-align:center;font-size:11px;">#</th>
          <th style="padding:8px 10px;color:#d1d5db;text-align:left;font-size:11px;">UNIDAD FUNC.</th>
          <th style="padding:8px 10px;color:#d1d5db;text-align:left;font-size:11px;">CONSORCISTA</th>
          <th style="padding:8px 10px;color:#d1d5db;text-align:right;font-size:11px;">SALDO ANTERIOR</th>
          <th style="padding:8px 10px;color:#d1d5db;text-align:right;font-size:11px;">PAGOS ${pagosHeader}</th>
          <th style="padding:8px 10px;color:#d1d5db;text-align:right;font-size:11px;">SALDO DEUDOR / A FAVOR</th>
          <th style="padding:8px 10px;color:#d1d5db;text-align:center;font-size:11px;">%</th>
          <th style="padding:8px 10px;color:#d1d5db;text-align:right;font-size:11px;">ORDINARIA EXPENSAS</th>
          <th style="padding:8px 10px;color:#d1d5db;text-align:right;font-size:11px;">TOTAL</th>
        </tr>
      </thead>
      <tbody>
        ${ownerRows}
        <tr style="background:#f3f4f6;border-top:2px solid #1a1a2e;font-weight:700;">
          <td colspan="3" style="padding:8px 10px;font-size:12px;color:#1a1a2e;">Total: ${owners.length}</td>
          <td style="padding:8px 10px;font-size:12px;color:#1a1a2e;text-align:right;">${formatCurrency(totalSaldoAnterior)}</td>
          <td style="padding:8px 10px;font-size:12px;color:#1a1a2e;text-align:right;">${formatCurrency(totalPagosMes)}</td>
          <td style="padding:8px 10px;font-size:12px;color:${totalSaldoDeudor < 0 ? '#dc2626' : '#1a1a2e'};text-align:right;">${formatCurrency(totalSaldoDeudor)}</td>
          <td style="padding:8px 10px;font-size:12px;color:#1a1a2e;text-align:center;">100%</td>
          <td style="padding:8px 10px;font-size:12px;color:#1a1a2e;text-align:right;">${formatCurrency(totalExpensasProrr)}</td>
          <td style="padding:8px 10px;font-size:12px;color:#1a1a2e;text-align:right;">${formatCurrency(totalFinal)}</td>
        </tr>
      </tbody>
    </table>

    <p style="margin-top:8px;font-size:10px;color:#9ca3af;line-height:1.4;">
      El saldo anterior es el importe a pagar del cupón de pago del mes anterior (expensas y deudas liquidadas) de cada unidad.<br>
      La columna saldo deudor no incluye intereses. Es el capital de deuda liquidado.
    </p>
  </div>` : '';

  // ── Sección 3: datos bancarios ────────────────────────────────
  const banco    = org.bankName    || 'Banco Roela';
  const cuenta   = org.bankAccount || '00000';
  const cbu      = org.bankCbu     || '0000000000000000000000';
  const titular  = org.bankHolder  || 'x';

  const bankSection = `
  <div style="margin-top:24px;padding:16px 20px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;">
    <div style="font-size:12px;font-weight:700;color:#1a1a2e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">
      Datos para transferencia bancaria
    </div>
    <table style="font-size:13px;color:#374151;border-collapse:collapse;">
      <tr>
        <td style="padding:3px 16px 3px 0;color:#6b7280;font-size:12px;">Banco:</td>
        <td style="padding:3px 0;font-weight:600;">${banco}</td>
      </tr>
      <tr>
        <td style="padding:3px 16px 3px 0;color:#6b7280;font-size:12px;">N° cuenta:</td>
        <td style="padding:3px 0;font-weight:600;">${cuenta}</td>
      </tr>
      <tr>
        <td style="padding:3px 16px 3px 0;color:#6b7280;font-size:12px;">CBU:</td>
        <td style="padding:3px 0;font-weight:600;letter-spacing:1px;">${cbu}</td>
      </tr>
      <tr>
        <td style="padding:3px 16px 3px 0;color:#6b7280;font-size:12px;">Titular:</td>
        <td style="padding:3px 0;font-weight:600;">${titular}</td>
      </tr>
    </table>
  </div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Expensas ${monthLabel} — ${org.name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      background: #ffffff;
      color: #111827;
      padding: 40px;
      font-size: 14px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 24px;
      border-bottom: 3px solid #1a1a2e;
      margin-bottom: 28px;
    }
    .org-name { font-size: 22px; font-weight: 800; color: #1a1a2e; }
    .org-meta  { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .period-badge { text-align: right; }
    .period-badge .label {
      font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #6b7280; font-weight: 600;
    }
    .period-badge .value {
      font-size: 20px; font-weight: 800; color: #1a1a2e; margin-top: 2px; text-transform: capitalize;
    }
    .period-badge .doc-label {
      font-size: 11px; color: #9ca3af; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;
    }
    .expenses-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 8px;
    }
    .grand-total {
      background: #1a1a2e;
      margin-top: 20px;
      border-radius: 8px;
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .grand-total .gt-label {
      font-size: 15px; font-weight: 700; color: #ffffff; text-transform: uppercase; letter-spacing: 1px;
    }
    .grand-total .gt-amount {
      font-size: 22px; font-weight: 800; color: #ffffff;
    }
    .footer {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
      font-size: 11px;
      color: #9ca3af;
    }
  </style>
</head>
<body>

  <div class="header">
    <div>
      <div class="org-name">${org.name}</div>
      <div class="org-meta">${org.address || 'Administración de Consorcio'}</div>
      ${org.cuit ? `<div class="org-meta">CUIT: ${org.cuit}</div>` : ''}
    </div>
    <div class="period-badge">
      <div class="label">Período</div>
      <div class="value">${monthLabel}</div>
      <div class="doc-label">Liquidación de Expensas</div>
    </div>
  </div>

  <table class="expenses-table">
    ${sectionHeader('Gastos Ordinarios', '#dbeafe')}
    ${renderRows(ordinary)}
    ${subtotalRow('Subtotal Gastos Ordinarios', totalOrd, '#eff6ff')}

    <tr><td colspan="5" style="padding:12px 0;"></td></tr>

    ${sectionHeader('Gastos Extraordinarios', '#fef3c7')}
    ${renderRows(extraordinary)}
    ${subtotalRow('Subtotal Gastos Extraordinarios', totalExt, '#fffbeb')}
  </table>

  <div class="grand-total">
    <div class="gt-label">Total General de Expensas</div>
    <div class="gt-amount">${formatCurrency(grandTotal)}</div>
  </div>

  ${estadoCuentasSection}

  ${bankSection}

  <div class="footer">
    ${org.name} — Liquidación generada automáticamente por GestionAr
  </div>

</body>
</html>`;
};

// ── GET /api/reports/expensas-pdf?month=YYYY-MM ───────────────
exports.getExpensasPdf = async (req, res, next) => {
  try {
    const { month } = req.query;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({
        success: false,
        message: 'Parámetro month inválido. Formato esperado: YYYY-MM',
      });
    }

    const orgId = req.orgId;
    const [year, mon] = month.split('-').map(Number);
    const monthStart  = new Date(year, mon - 1, 1);
    const monthEnd    = new Date(year, mon, 0, 23, 59, 59, 999);

    const [org, expenses, rawMembers, orgUnits, monthPayments, categoryLabels] = await Promise.all([
      Organization.findById(orgId).select('name address cuit dueDayOfMonth lateFeePercent bankName bankAccount bankCbu bankHolder'),
      Expense.find({
        organization: orgId,
        isActive: { $ne: false },
        date: { $gte: monthStart, $lte: monthEnd },
      })
        .populate('provider', 'name cuit')
        .sort({ expenseType: 1, category: 1, date: 1 })
        .lean(),
      OrganizationMember.find({ organization: orgId, role: 'owner', isActive: true })
        .populate('user', 'name unit')
        .lean(),
      Unit.find({ organization: orgId, active: true })
        .select('owner name balance')
        .lean(),
      Payment.find({ organization: orgId, status: 'approved', month })
        .select('owner amount')
        .lean(),
      getExpenseCategoryLabelMap(orgId),
    ]);

    if (!org) {
      return res.status(404).json({ success: false, message: 'Organización no encontrada.' });
    }

    const unitsByOwner = {};
    orgUnits.forEach(unit => {
      if (!unit.owner) return;
      const key = unit.owner.toString();
      (unitsByOwner[key] ||= []).push(unit);
    });

    // Construir lista de propietarios desde OrganizationMember y saldos por unidad
    const owners = rawMembers
      .filter(m => m.user)
      .map(m => {
        const ownerUnits = unitsByOwner[m.user._id.toString()] || [];
        return {
          _id:        m.user._id,
          name:       m.user.name,
          unit:       ownerUnits.map(unit => unit.name).join(', ') || m.user.unit,
          balance:    ownerUnits.reduce((sum, unit) => sum + Number(unit.balance || 0), 0),
          percentage: m.percentage,
        };
      })
      .sort((a, b) => (a.unit || '').localeCompare(b.unit || ''));

    // Agrupar pagos por propietario
    const paymentsByOwner = {};
    monthPayments.forEach(p => {
      const ownerId = p.owner.toString();
      paymentsByOwner[ownerId] = (paymentsByOwner[ownerId] || 0) + p.amount;
    });

    const ordinary      = expenses.filter(e => e.expenseType !== 'extraordinary');
    const extraordinary = expenses.filter(e => e.expenseType === 'extraordinary');

    const html = buildExpensasHTML(org, month, ordinary, extraordinary, owners, paymentsByOwner, categoryLabels);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    let buffer;
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      buffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
    } finally {
      await browser.close();
    }

    const filename = `expensas_${month}.pdf`;
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      buffer.length,
    });
    res.end(buffer);

    logger.info(`[reportController] PDF expensas generado org=${orgId} month=${month}`);
  } catch (err) {
    next(err);
  }
};
