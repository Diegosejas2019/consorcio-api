const puppeteer    = require('puppeteer');
const Payment      = require('../models/Payment');
const Expense      = require('../models/Expense');
const Organization = require('../models/Organization');
const logger       = require('../config/logger');

const CATEGORIES = ['cleaning', 'security', 'maintenance', 'utilities', 'administration', 'other'];

const CATEGORY_LABELS = {
  cleaning:       'Limpieza',
  security:       'Seguridad',
  maintenance:    'Mantenimiento',
  utilities:      'Servicios',
  administration: 'Administración',
  other:          'Otros',
};

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

    const [incomeAgg, expensesAgg, prevIncomeAgg, prevExpensesAgg] = await Promise.all([
      Payment.aggregate([
        { $match: { organization: orgId, status: 'approved', month } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Expense.aggregate([
        { $match: { organization: orgId, status: 'paid', date: { $gte: monthStart, $lte: monthEnd } } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
      ]),
      Payment.aggregate([
        { $match: { organization: orgId, status: 'approved', month: { $lt: month } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Expense.aggregate([
        { $match: { organization: orgId, status: 'paid', date: { $lt: monthStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const income        = incomeAgg[0]?.total        || 0;
    const saldoAnterior = (prevIncomeAgg[0]?.total   || 0) - (prevExpensesAgg[0]?.total || 0);

    const expMap    = Object.fromEntries(expensesAgg.map(e => [e._id, e.total]));
    const expenses  = Object.fromEntries(CATEGORIES.map(c => [c, expMap[c] || 0]));
    const expTotal  = CATEGORIES.reduce((sum, c) => sum + expenses[c], 0);

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

const buildExpensasHTML = (org, month, ordinary, extraordinary) => {
  const monthLabel = formatMonthLabel(month);
  const totalOrd   = ordinary.reduce((s, e) => s + e.amount, 0);
  const totalExt   = extraordinary.reduce((s, e) => s + e.amount, 0);
  const grandTotal = totalOrd + totalExt;

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
          <td style="padding:10px 12px;font-size:13px;color:#374151;">${prov}<br><span style="font-size:11px;color:#9ca3af;">${CATEGORY_LABELS[e.category] || e.category}</span></td>
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
    .period-badge {
      text-align: right;
    }
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

    const [org, expenses] = await Promise.all([
      Organization.findById(orgId).select('name address cuit'),
      Expense.find({
        organization: orgId,
        date: { $gte: monthStart, $lte: monthEnd },
      })
        .populate('provider', 'name cuit')
        .sort({ expenseType: 1, category: 1, date: 1 })
        .lean(),
    ]);

    if (!org) {
      return res.status(404).json({ success: false, message: 'Organización no encontrada.' });
    }

    const ordinary      = expenses.filter(e => e.expenseType !== 'extraordinary');
    const extraordinary = expenses.filter(e => e.expenseType === 'extraordinary');

    const html = buildExpensasHTML(org, month, ordinary, extraordinary);

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
