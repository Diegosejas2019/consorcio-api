const { cloudinary } = require('../config/cloudinary');
const { Readable }   = require('stream');
const logger         = require('../config/logger');
const { launchBrowser } = require('../utils/puppeteerLauncher');

const formatCurrency = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n ?? 0);

const formatDate = (d) =>
  d ? new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

const typeLabel = (t) => ({
  remunerative: 'Remun.',
  non_remunerative: 'No Remun.',
  deduction: 'Descuento',
  employer_contribution: 'Contrib. Empleador',
})[t] || t;

function buildReceiptHTML({ liquidation, employee, setting, isDraft }) {
  const itemRows = (liquidation.itemsSnapshot || []).map(item => `
    <tr>
      <td class="code">${item.code}</td>
      <td>${item.label}</td>
      <td class="type-badge ${item.type}">${typeLabel(item.type)}</td>
      <td class="amount">${formatCurrency(item.amount)}</td>
    </tr>`).join('');

  const draftBanner = isDraft
    ? `<div class="draft-banner">BORRADOR — No es recibo legal de sueldo</div>`
    : '';

  const periodLabel = (() => {
    const [year, month] = liquidation.period.split('-');
    const date = new Date(Number(year), Number(month) - 1, 1);
    return date.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }).replace(/^\w/, c => c.toUpperCase());
  })();

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Recibo de Sueldo — ${employee.name} — ${liquidation.period}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #fff; color: #111; padding: 40px; font-size: 13px; line-height: 1.5; }
    .draft-banner { background: #fff3cd; border: 2px solid #ffc107; color: #856404; text-align: center; padding: 10px 16px; font-size: 15px; font-weight: bold; border-radius: 4px; margin-bottom: 24px; }
    h1 { font-size: 20px; color: #1a1a2e; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; }
    .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
    .info-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; }
    .info-box h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 8px; }
    .info-box p { font-size: 13px; margin-bottom: 3px; }
    .info-box strong { font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { background: #1a1a2e; color: #fff; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; padding: 9px 12px; text-align: left; }
    td { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) { background: #f9fafb; }
    .code { font-family: monospace; font-size: 11px; color: #6b7280; }
    .amount { text-align: right; font-variant-numeric: tabular-nums; }
    .type-badge { font-size: 11px; }
    .type-badge.remunerative { color: #166534; }
    .type-badge.non_remunerative { color: #1e40af; }
    .type-badge.deduction { color: #991b1b; }
    .type-badge.employer_contribution { color: #5b21b6; }
    .totals { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px 20px; margin-bottom: 24px; }
    .totals-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .total-row { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; }
    .total-row.net { font-size: 16px; font-weight: bold; border-top: 2px solid #1a1a2e; margin-top: 8px; padding-top: 10px; }
    .footer { font-size: 11px; color: #9ca3af; text-align: center; margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 16px; }
  </style>
</head>
<body>
  ${draftBanner}
  <h1>Recibo de Haberes</h1>
  <p class="subtitle">Período: ${periodLabel} · ${liquidation.liquidationTypeLabel || liquidation.liquidationType}</p>

  <div class="header-grid">
    <div class="info-box">
      <h3>Empleador</h3>
      <p><strong>${setting?.employerLegalName || '—'}</strong></p>
      <p>CUIT: ${setting?.employerCuit || '—'}</p>
      <p>${setting?.employerAddress || ''}</p>
    </div>
    <div class="info-box">
      <h3>Empleado</h3>
      <p><strong>${employee.name}</strong></p>
      <p>Rol: ${employee.role || '—'}</p>
      <p>Ingreso: ${formatDate(employee.hireDate)}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:90px">Código</th>
        <th>Concepto</th>
        <th style="width:120px">Tipo</th>
        <th style="width:120px; text-align:right">Importe</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div class="totals">
    <div class="totals-grid">
      <div>
        <div class="total-row"><span>Remunerativo bruto</span><span>${formatCurrency(liquidation.grossRemunerative)}</span></div>
        <div class="total-row"><span>No remunerativo bruto</span><span>${formatCurrency(liquidation.grossNonRemunerative)}</span></div>
        <div class="total-row"><span>Total descuentos</span><span>− ${formatCurrency(liquidation.deductionsTotal)}</span></div>
      </div>
      <div>
        <div class="total-row"><span>Contrib. empleador</span><span>${formatCurrency(liquidation.employerContributionsTotal)}</span></div>
        <div class="total-row net"><span>Neto a cobrar</span><span>${formatCurrency(liquidation.netPay)}</span></div>
      </div>
    </div>
  </div>

  ${(liquidation.warnings || []).length > 0 ? `
  <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:10px 14px;margin-bottom:16px;font-size:11px;color:#856404;">
    ${liquidation.warnings.map(w => `<p>⚠ ${w}</p>`).join('')}
  </div>` : ''}

  <div class="footer">
    <p>Generado por GestionAr Consorcios — ${new Date().toLocaleString('es-AR')} — Este documento es un comprobante interno y no reemplaza el recibo legal de sueldo (Art. 52 LCT).</p>
  </div>
</body>
</html>`;
}

async function generateReceiptPdf({ liquidation, employee, setting, isDraft }) {
  const html = buildReceiptHTML({ liquidation, employee, setting, isDraft });

  const browser = await launchBrowser({
    headless: 'new',
    args: ['--disable-gpu'],
  });

  let pdfBuffer;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }

  // Subir a Cloudinary
  const publicId = `payroll-receipts/${liquidation.organization}/${liquidation._id}`;
  const uploadResult = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', public_id: publicId, format: 'pdf', overwrite: true },
      (err, result) => { if (err) reject(err); else resolve(result); }
    );
    Readable.from(pdfBuffer).pipe(stream);
  });

  logger.info(`Recibo PDF generado: ${publicId}`);
  return { url: uploadResult.secure_url, publicId: uploadResult.public_id };
}

module.exports = { generateReceiptPdf };
