const puppeteer      = require('puppeteer');
const Payment        = require('../models/Payment');
const Organization   = require('../models/Organization');
const User           = require('../models/User');
const { cloudinary } = require('../config/cloudinary');
const logger         = require('../config/logger');

// ── Helpers ───────────────────────────────────────────────────

const padNumber = (n) => String(n).padStart(8, '0');

const formatCurrency = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n ?? 0);

const formatDate = (d) =>
  new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

const paymentMethodLabel = (method) =>
  method === 'mercadopago' ? 'MercadoPago' : 'Transferencia / Efectivo';

// ── HTML del recibo ───────────────────────────────────────────

const buildReceiptHTML = (payment, owner, org) => {
  const receiptDate = formatDate(payment.receiptIssuedAt || new Date());
  const totalAmount = payment.amount ?? 0;

  // Mostrar unidades en el info-box del propietario
  const unitDisplay = payment.breakdown?.length > 0
    ? payment.breakdown.map(b => b.name).join(', ')
    : (owner.unit || '—');

  // Filas de detalle: una por unidad si hay breakdown, o fila única
  const detailRows = payment.breakdown?.length > 0
    ? payment.breakdown.map(b => `
      <tr>
        <td>${org.feeLabel || 'Cuota'} — ${b.name} — ${payment.monthFormatted}</td>
        <td>${formatCurrency(b.amount)}</td>
      </tr>`).join('')
    : `<tr>
        <td>${org.feeLabel || 'Cuota'} — ${payment.monthFormatted}</td>
        <td>${formatCurrency(totalAmount)}</td>
      </tr>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Recibo ${payment.receiptNumber}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      background: #ffffff;
      color: #111827;
      padding: 48px;
      font-size: 14px;
      line-height: 1.6;
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 28px;
      border-bottom: 2px solid #1a1a2e;
      margin-bottom: 32px;
    }
    .org-name {
      font-size: 22px;
      font-weight: 700;
      color: #1a1a2e;
      letter-spacing: -0.5px;
    }
    .org-subtitle {
      font-size: 12px;
      color: #6b7280;
      margin-top: 4px;
    }
    .receipt-badge {
      text-align: right;
    }
    .receipt-badge .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: #6b7280;
      font-weight: 600;
    }
    .receipt-badge .number {
      font-size: 20px;
      font-weight: 700;
      color: #1a1a2e;
      margin-top: 2px;
    }
    .receipt-badge .date {
      font-size: 12px;
      color: #6b7280;
      margin-top: 4px;
    }

    /* Status banner */
    .status-banner {
      background: #d1fae5;
      border: 1.5px solid #6ee7b7;
      border-radius: 10px;
      padding: 14px 20px;
      margin-bottom: 28px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      background: #10b981;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-text {
      font-weight: 700;
      font-size: 14px;
      color: #065f46;
      letter-spacing: 0.5px;
    }

    /* Info grid */
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 28px;
    }
    .info-box {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 16px;
    }
    .info-box .box-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #9ca3af;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .info-box .box-value {
      font-size: 15px;
      font-weight: 600;
      color: #111827;
    }
    .info-box .box-sub {
      font-size: 12px;
      color: #6b7280;
      margin-top: 2px;
    }

    /* Tabla de detalle */
    .detail-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    .detail-table thead tr {
      background: #1a1a2e;
      color: #fff;
    }
    .detail-table thead th {
      padding: 12px 16px;
      text-align: left;
      font-size: 12px;
      letter-spacing: 0.5px;
      font-weight: 600;
    }
    .detail-table thead th:last-child { text-align: right; }
    .detail-table tbody tr {
      border-bottom: 1px solid #f3f4f6;
    }
    .detail-table tbody td {
      padding: 14px 16px;
      font-size: 14px;
      color: #374151;
    }
    .detail-table tbody td:last-child { text-align: right; font-weight: 500; }
    .detail-table tfoot tr {
      border-top: 2px solid #1a1a2e;
    }
    .detail-table tfoot td {
      padding: 14px 16px;
      font-size: 16px;
      font-weight: 700;
      color: #1a1a2e;
    }
    .detail-table tfoot td:last-child { text-align: right; }

    /* Footer */
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
    }
    .footer .valid-note {
      font-size: 12px;
      color: #6b7280;
      font-style: italic;
    }
    .footer .org-footer {
      font-size: 11px;
      color: #9ca3af;
      margin-top: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>

  <div class="header">
    <div>
      <div class="org-name">${org.name}</div>
      <div class="org-subtitle">${org.address || 'Administración de propiedades'}</div>
    </div>
    <div class="receipt-badge">
      <div class="label">Recibo N°</div>
      <div class="number">${payment.receiptNumber}</div>
      <div class="date">Emitido: ${receiptDate}</div>
    </div>
  </div>

  <div class="status-banner">
    <div class="status-dot"></div>
    <div class="status-text">PAGO ACREDITADO</div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <div class="box-label">${org.memberLabel || 'Propietario'}</div>
      <div class="box-value">${owner.name}</div>
      <div class="box-sub">${org.unitLabel || 'Unidad'}: ${unitDisplay}</div>
    </div>
    <div class="info-box">
      <div class="box-label">Período</div>
      <div class="box-value">${payment.monthFormatted}</div>
      <div class="box-sub">Medio de pago: ${paymentMethodLabel(payment.paymentMethod)}</div>
    </div>
  </div>

  <table class="detail-table">
    <thead>
      <tr>
        <th>Concepto</th>
        <th style="text-align:right">Importe</th>
      </tr>
    </thead>
    <tbody>
      ${detailRows}
    </tbody>
    <tfoot>
      <tr>
        <td>Total abonado</td>
        <td>${formatCurrency(totalAmount)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="footer">
    <div class="valid-note">Este documento es un comprobante válido de pago.</div>
    <div class="org-footer">${org.name} — Generado automáticamente por GestionAr</div>
  </div>

</body>
</html>`;
};

// ── PDF con Puppeteer ─────────────────────────────────────────

const generatePDF = async (html) => {
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
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return buffer;
  } finally {
    await browser.close();
  }
};

// ── Upload a Cloudinary ───────────────────────────────────────

const uploadReceipt = async (buffer, receiptNumber) => {
  const pdfBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const b64     = pdfBuffer.toString('base64');
  const dataUri = `data:application/pdf;base64,${b64}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    folder:        'consorcio/recibos',
    resource_type: 'raw',
    public_id:     `recibo_${receiptNumber}`,
    format:        'pdf',
    type:          'upload',
  });

  return { url: result.secure_url, publicId: result.public_id };
};

// ── Método principal ──────────────────────────────────────────

exports.generateAndStoreReceipt = async (paymentId) => {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw new Error(`Pago ${paymentId} no encontrado`);

  if (payment.systemReceipt?.url) {
    logger.info(`[receiptService] Recibo ya generado para pago ${paymentId}`);
    return payment;
  }

  const [owner, org] = await Promise.all([
    User.findById(payment.owner).select('name unit email'),
    Organization.findByIdAndUpdate(
      payment.organization,
      { $inc: { receiptCounter: 1 } },
      { new: true }
    ).select('name address feeLabel memberLabel unitLabel receiptCounter'),
  ]);

  if (!owner || !org) throw new Error('Propietario u organización no encontrados');

  const receiptNumber = `REC-${padNumber(org.receiptCounter)}`;

  payment.receiptNumber   = receiptNumber;
  payment.receiptIssuedAt = new Date();
  await payment.save();

  const html   = buildReceiptHTML(payment, owner, org);
  const buffer = await generatePDF(html);
  const { url, publicId } = await uploadReceipt(buffer, receiptNumber);

  payment.systemReceipt = { url, publicId };
  await payment.save();

  logger.info(`[receiptService] Recibo generado: ${receiptNumber} — pago ${paymentId}`);
  return payment;
};

exports.buildReceiptHTML = buildReceiptHTML;
