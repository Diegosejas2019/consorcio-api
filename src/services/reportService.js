const Payment            = require('../models/Payment');
const Expense            = require('../models/Expense');
const Organization       = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Unit               = require('../models/Unit');
const { getExpenseCategoryLabelMap } = require('./expenseCategoryService');

function appError(msg, code) {
  const err = new Error(msg);
  err.statusCode = code;
  return err;
}

// ── Format helpers ────────────────────────────────────────────────────────────

const formatARS = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n ?? 0);

const formatDate = (d) =>
  d ? new Date(d).toLocaleDateString('es-AR') : '—';

const statusLabel = (s) =>
  ({ approved: 'Aprobado', pending: 'Pendiente', rejected: 'Rechazado' }[s] || s);

const methodLabel = (m) =>
  ({ manual: 'Manual', mercadopago: 'MercadoPago' }[m] || m || '—');

// ── Helper: map userId → unit names for an org ───────────────────────────────

async function getUnitsByOwner(orgId) {
  const units = await Unit.find({ organization: orgId, active: true })
    .select('owner name')
    .lean();
  const map = {};
  units.forEach(u => {
    if (!u.owner) return;
    const key = u.owner.toString();
    (map[key] ||= []).push(u.name);
  });
  return map;
}

// ── Shared: parse date range ──────────────────────────────────────────────────

function parseDateRange(from, to) {
  const fromDate = from ? new Date(from) : new Date(0);
  const toDate   = to
    ? new Date(new Date(to).setHours(23, 59, 59, 999))
    : new Date();
  return { fromDate, toDate };
}

// ── 1. Estado de cuenta por propietario ──────────────────────────────────────

exports.getOwnerStatementData = async ({ orgId, ownerId, from, to, includePending = true }) => {
  // ownerId = OrganizationMember._id (ID que devuelve api.owners.getAll)
  // IDOR protection: validate ownerId belongs to orgId
  const member = await OrganizationMember.findOne({
    _id:          ownerId,
    organization: orgId,
    role:         'owner',
  })
    .populate('user', 'name email phone phones')
    .lean();

  if (!member) throw appError('Propietario no encontrado en esta organización.', 404);

  const userId = member.user._id; // User._id for payment queries

  const [org, unitsByOwner] = await Promise.all([
    Organization.findById(orgId)
      .select('name businessType monthlyFee feeLabel')
      .lean(),
    getUnitsByOwner(orgId),
  ]);

  const unitLabel = unitsByOwner[userId.toString()]?.join(', ') || '—';
  const { fromDate, toDate } = parseDateRange(from, to);

  const allPayments = await Payment.find({
    organization: orgId,
    owner:        userId,  // Payment.owner is a ref to User._id
    createdAt:    { $gte: fromDate, $lte: toDate },
  })
    .populate('reviewedBy', 'name')
    .sort({ createdAt: -1 })
    .lean();

  const toRow = (p) => ({
    date:           p.createdAt,
    month:          p.month || null,
    type:           p.type,
    amount:         p.amount,
    status:         p.status,
    paymentMethod:  p.paymentMethod,
    reviewedByName: p.reviewedBy?.name || '—',
  });

  const approved = allPayments.filter(p => p.status === 'approved');
  const pending  = allPayments.filter(p => p.status === 'pending');

  return {
    owner: {
      name:               member.user.name,
      email:              member.user.email,
      phone:              member.user.phone || member.user.phones?.[0]?.number || '—',
      unitLabel,
      balance:            member.balance || 0,
      startBillingPeriod: member.startBillingPeriod,
      isDebtor:           member.isDebtor,
    },
    org: {
      name:        org.name,
      businessType: org.businessType,
      monthlyFee:  org.monthlyFee || 0,
      feeLabel:    org.feeLabel || 'Expensa',
    },
    payments: {
      approved:  approved.map(toRow),
      pending:   includePending ? pending.map(toRow) : [],
    },
    summary: {
      totalApproved:  approved.reduce((s, p) => s + p.amount, 0),
      totalPending:   includePending ? pending.reduce((s, p) => s + p.amount, 0) : 0,
      currentBalance: member.balance || 0,
      count:          allPayments.length,
    },
    filters: {
      from:           fromDate.toISOString(),
      to:             toDate.toISOString(),
      includePending: !!includePending,
    },
  };
};

// ── 2. Morosidad general ──────────────────────────────────────────────────────

exports.getDelinquencyData = async ({ orgId, minDebt = 0 }) => {
  const members = await OrganizationMember.find({
    organization: orgId,
    role:         'owner',
    isActive:     true,
    isDebtor:     true,
  })
    .populate('user', 'name email phone phones')
    .lean();

  const unitsByOwner = await getUnitsByOwner(orgId);

  let owners = members
    .filter(m => m.user)
    .map(m => ({
      name:               m.user.name,
      email:              m.user.email,
      phone:              m.user.phone || m.user.phones?.[0]?.number || '—',
      unitLabel:          unitsByOwner[m.user._id.toString()]?.join(', ') || '—',
      balance:            m.balance || 0,
      isDebtor:           m.isDebtor,
      startBillingPeriod: m.startBillingPeriod,
    }))
    .filter(o => minDebt <= 0 || o.balance < -Math.abs(minDebt));

  // Más deudor primero (balance más negativo)
  owners.sort((a, b) => a.balance - b.balance);

  const totalDebt = owners.reduce((s, o) => s + Math.min(o.balance, 0), 0);

  return {
    owners,
    summary: {
      totalDebtors: owners.length,
      totalDebt:    Math.abs(totalDebt),
      avgDebt:      owners.length > 0 ? Math.abs(totalDebt / owners.length) : 0,
    },
  };
};

// ── 3. Pagos por período ──────────────────────────────────────────────────────

exports.getPaymentsData = async ({ orgId, from, to, status, ownerId }) => {
  const { fromDate, toDate } = parseDateRange(from, to);

  const filter = {
    organization: orgId,
    createdAt:    { $gte: fromDate, $lte: toDate },
  };
  if (status)  filter.status = status;
  if (ownerId) filter.owner  = ownerId;

  const [payments, unitsByOwner] = await Promise.all([
    Payment.find(filter)
      .populate('owner',      'name email')
      .populate('reviewedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean(),
    getUnitsByOwner(orgId),
  ]);

  const rows = payments.map(p => ({
    date:           p.createdAt,
    ownerName:      p.owner?.name  || '—',
    ownerEmail:     p.owner?.email || '—',
    unitLabel:      unitsByOwner[p.owner?._id?.toString()]?.join(', ') || '—',
    month:          p.month || '—',
    type:           p.type,
    amount:         p.amount,
    status:         p.status,
    paymentMethod:  p.paymentMethod,
    reviewedByName: p.reviewedBy?.name || '—',
  }));

  const approved = rows.filter(r => r.status === 'approved');
  const pending  = rows.filter(r => r.status === 'pending');

  return {
    payments: rows,
    summary: {
      count:         rows.length,
      totalApproved: approved.reduce((s, r) => s + r.amount, 0),
      totalPending:  pending.reduce((s, r) => s + r.amount, 0),
      total:         rows.reduce((s, r) => s + r.amount, 0),
    },
    truncated: payments.length === 1000,
  };
};

// ── 4. Gastos por período ─────────────────────────────────────────────────────

exports.getExpensesData = async ({ orgId, from, to, category, expenseType }) => {
  const { fromDate, toDate } = parseDateRange(from, to);

  const filter = {
    organization: orgId,
    isActive:     { $ne: false },
    date:         { $gte: fromDate, $lte: toDate },
  };
  if (category)    filter.category    = category;
  if (expenseType) filter.expenseType = expenseType;

  const [expenses, categoryLabelMap] = await Promise.all([
    Expense.find(filter)
      .populate('provider', 'name serviceType cuit')
      .sort({ date: -1 })
      .limit(1000)
      .lean(),
    getExpenseCategoryLabelMap(orgId),
  ]);

  const rows = expenses.map(e => ({
    date:          e.date,
    description:   e.description,
    category:      e.category,
    categoryLabel: categoryLabelMap[e.category] || e.category,
    expenseType:   e.expenseType || 'ordinary',
    amount:        e.amount,
    status:        e.status,
    providerName:  e.provider?.name || '—',
    invoiceNumber: e.invoiceNumber  || '—',
    isChargeable:  e.isChargeable   || false,
  }));

  const ordinary      = rows.filter(r => r.expenseType !== 'extraordinary');
  const extraordinary = rows.filter(r => r.expenseType === 'extraordinary');

  return {
    expenses: rows,
    summary: {
      count:              rows.length,
      total:              rows.reduce((s, r) => s + r.amount, 0),
      totalOrdinary:      ordinary.reduce((s, r) => s + r.amount, 0),
      totalExtraordinary: extraordinary.reduce((s, r) => s + r.amount, 0),
    },
    truncated: expenses.length === 1000,
  };
};

// ── 5. Propietarios/unidades ──────────────────────────────────────────────────

exports.getOwnersData = async ({ orgId, includeInactive = false }) => {
  const filter = { organization: orgId, role: 'owner' };
  if (!includeInactive) filter.isActive = true;

  const [members, unitsByOwner] = await Promise.all([
    OrganizationMember.find(filter)
      .populate('user', 'name email phone phones createdAt')
      .sort({ createdAt: 1 })
      .lean(),
    getUnitsByOwner(orgId),
  ]);

  const owners = members
    .filter(m => m.user)
    .map(m => ({
      name:               m.user.name,
      email:              m.user.email,
      phone:              m.user.phone || m.user.phones?.[0]?.number || '—',
      unitLabel:          unitsByOwner[m.user._id.toString()]?.join(', ') || '—',
      isActive:           m.isActive,
      isDebtor:           m.isDebtor,
      balance:            m.balance || 0,
      startBillingPeriod: m.startBillingPeriod,
      createdAt:          m.createdAt,
    }));

  return {
    owners,
    summary: {
      total:   owners.length,
      active:  owners.filter(o => o.isActive).length,
      debtors: owners.filter(o => o.isDebtor).length,
    },
  };
};

// ── 6. HTML para PDF de estado de cuenta ─────────────────────────────────────

exports.generateOwnerStatementHtml = (statementData) => {
  const { owner, org, payments, summary, filters } = statementData;

  const fromLabel = filters.from ? new Date(filters.from).toLocaleDateString('es-AR') : '—';
  const toLabel   = filters.to   ? new Date(filters.to).toLocaleDateString('es-AR')   : '—';
  const today     = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });
  const balColor  = summary.currentBalance < 0 ? '#dc2626' : '#16a34a';

  const renderRows = (list, amtColor) => {
    if (!list.length) {
      return `<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:12px 10px;">Sin movimientos en el período</td></tr>`;
    }
    return list.map((p, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : '#f9fafb';
      return `<tr style="background:${bg};border-bottom:1px solid #f3f4f6;">
        <td style="padding:8px 10px;font-size:12px;color:#374151;">${formatDate(p.date)}</td>
        <td style="padding:8px 10px;font-size:12px;color:#374151;">${p.month || '—'}</td>
        <td style="padding:8px 10px;font-size:12px;color:#374151;">${statusLabel(p.status)}</td>
        <td style="padding:8px 10px;font-size:12px;color:#374151;">${methodLabel(p.paymentMethod)}</td>
        <td style="padding:8px 10px;font-size:13px;color:${amtColor};text-align:right;font-weight:600;">${formatARS(p.amount)}</td>
      </tr>`;
    }).join('');
  };

  const thStyle = 'padding:8px 10px;text-align:left;font-size:11px;';
  const tableHead = `<thead><tr style="background:#1a1a2e;">
    <th style="${thStyle}color:#d1d5db;">Fecha</th>
    <th style="${thStyle}color:#d1d5db;">Período</th>
    <th style="${thStyle}color:#d1d5db;">Estado</th>
    <th style="${thStyle}color:#d1d5db;">Canal</th>
    <th style="${thStyle}color:#d1d5db;text-align:right;">Importe</th>
  </tr></thead>`;

  const pendingSection = (filters.includePending && payments.pending.length > 0) ? `
  <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#92400e;margin:20px 0 8px;">
    Pagos pendientes de aprobación
  </h3>
  <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:4px;">
    <thead><tr style="background:#fef3c7;">
      <th style="${thStyle}color:#78350f;">Fecha</th>
      <th style="${thStyle}color:#78350f;">Período</th>
      <th style="${thStyle}color:#78350f;">Estado</th>
      <th style="${thStyle}color:#78350f;">Canal</th>
      <th style="${thStyle}color:#78350f;text-align:right;">Importe</th>
    </tr></thead>
    <tbody>${renderRows(payments.pending, '#92400e')}</tbody>
  </table>
  <p style="font-size:10px;color:#9ca3af;margin-top:4px;">
    * Los pagos pendientes no descuentan del saldo hasta ser aprobados por el administrador.
  </p>` : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Estado de Cuenta — ${owner.name}</title>
  <style>
    * { margin:0;padding:0;box-sizing:border-box; }
    body { font-family:'Helvetica Neue',Arial,sans-serif;background:#fff;color:#111827;padding:40px;font-size:14px;line-height:1.5; }
    .header { display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:3px solid #1a1a2e;margin-bottom:24px; }
    .footer { margin-top:28px;padding-top:14px;border-top:1px solid #e5e7eb;text-align:center;font-size:10px;color:#9ca3af; }
  </style>
</head>
<body>

  <div class="header">
    <div>
      <div style="font-size:20px;font-weight:800;color:#1a1a2e;">${org.name}</div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6b7280;margin-top:4px;">Estado de Cuenta</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:11px;color:#6b7280;">Fecha de emisión</div>
      <div style="font-size:14px;font-weight:700;color:#1a1a2e;">${today}</div>
    </div>
  </div>

  <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:24px;padding:16px 20px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
    <div>
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Propietario</div>
      <div style="font-size:15px;font-weight:700;color:#1a1a2e;margin-top:2px;">${owner.name}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px;">${owner.email}</div>
    </div>
    <div>
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Unidad / Lote</div>
      <div style="font-size:15px;font-weight:700;color:#1a1a2e;margin-top:2px;">${owner.unitLabel}</div>
    </div>
    <div>
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Período consultado</div>
      <div style="font-size:13px;font-weight:600;color:#1a1a2e;margin-top:2px;">${fromLabel} → ${toLabel}</div>
    </div>
    <div>
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">Saldo actual</div>
      <div style="font-size:16px;font-weight:800;color:${balColor};margin-top:2px;">${formatARS(summary.currentBalance)}</div>
    </div>
  </div>

  <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#1a1a2e;margin-bottom:8px;">
    Pagos aprobados en el período
  </h3>
  <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:4px;">
    ${tableHead}
    <tbody>${renderRows(payments.approved, '#16a34a')}</tbody>
  </table>

  <div style="margin-top:20px;padding:16px 20px;background:#1a1a2e;border-radius:8px;display:flex;justify-content:space-around;flex-wrap:wrap;gap:16px;">
    <div style="text-align:center;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#9ca3af;">Total aprobado</div>
      <div style="font-size:16px;font-weight:800;color:#4ade80;margin-top:4px;">${formatARS(summary.totalApproved)}</div>
    </div>
    ${filters.includePending ? `
    <div style="text-align:center;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#9ca3af;">Total pendiente</div>
      <div style="font-size:16px;font-weight:800;color:#fbbf24;margin-top:4px;">${formatARS(summary.totalPending)}</div>
    </div>` : ''}
    <div style="text-align:center;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#9ca3af;">Saldo actual</div>
      <div style="font-size:16px;font-weight:800;color:${balColor};margin-top:4px;">${formatARS(summary.currentBalance)}</div>
    </div>
  </div>

  ${pendingSection}

  <div class="footer">
    ${org.name} — Estado de cuenta generado por GestionAr el ${today}
  </div>

</body>
</html>`;
};
