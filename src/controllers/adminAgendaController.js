const Expense                 = require('../models/Expense');
const Payment                 = require('../models/Payment');
const UnidentifiedPayment     = require('../models/UnidentifiedPayment');
const Claim                   = require('../models/Claim');
const Salary                  = require('../models/Salary');
const MonthlyRendition        = require('../models/MonthlyRendition');
const OrganizationAccessRequest = require('../models/OrganizationAccessRequest');
const AdminTask               = require('../models/AdminTask');
const Provider                = require('../models/Provider');

const CLAIM_STALE_DAYS = 7;

function _prevPeriod(period) {
  if (!period) return null;
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function _daysAgo(date) {
  return Math.floor((Date.now() - new Date(date)) / 86400000);
}

function _expensePriority(date) {
  const days = _daysAgo(date);
  if (days > 30) return 'high';
  if (days > 7)  return 'medium';
  return 'low';
}

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

exports.getAgenda = async (req, res, next) => {
  try {
    const orgId     = req.orgId;
    const period    = req.org?.feePeriodCode || null;
    const prevPeriod = _prevPeriod(period);
    const staleDate  = new Date(Date.now() - CLAIM_STALE_DAYS * 86400000);

    const today = new Date();
    const in30  = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [
      expenses,
      pendingPaymentsCount,
      pendingUnidentCount,
      staleClaims,
      dueSalaries,
      currentRendition,
      pendingAccessReqsCount,
      adminTasks,
      providersWithExpiry,
    ] = await Promise.all([
      Expense.find({ organization: orgId, status: 'pending', isActive: true })
        .select('description amount date category expenseType')
        .sort({ date: 1 })
        .limit(50)
        .lean(),

      Payment.countDocuments({ organization: orgId, status: 'pending' }),

      UnidentifiedPayment.countDocuments({
        organization: orgId,
        status: 'pending',
        isDeleted: { $ne: true },
      }),

      Claim.find({
        organization: orgId,
        status: 'open',
        createdAt: { $lt: staleDate },
        isActive: true,
      })
        .select('title createdAt owner')
        .populate('owner', 'name')
        .limit(20)
        .lean(),

      Salary.find({
        organization: orgId,
        status: { $in: ['pending', 'partially_paid'] },
        period: { $in: [period, prevPeriod].filter(Boolean) },
      })
        .select('period status totalAmount paidAmount employee')
        .populate('employee', 'name')
        .limit(20)
        .lean(),

      MonthlyRendition.findOne({ organization: orgId, period })
        .select('status period')
        .lean(),

      OrganizationAccessRequest.countDocuments({ organization: orgId, status: 'pending' }),

      AdminTask.find({ organization: orgId, status: 'pending' })
        .select('title notes dueDate priority createdAt')
        .sort({ dueDate: 1, priority: -1 })
        .limit(50)
        .lean(),

      Provider.find({
        organization: orgId,
        active: true,
        'documents.expirationDate': { $lte: in30 },
      })
        .select('name documents')
        .lean(),
    ]);

    const items = [];

    expenses.forEach(e => {
      items.push({
        type:     'expense_due',
        id:       e._id,
        title:    e.description,
        subtitle: `$${(e.amount || 0).toLocaleString('es-AR')} · ${e.category || ''}`,
        date:     e.date || null,
        priority: _expensePriority(e.date),
        meta:     { amount: e.amount, category: e.category, expenseType: e.expenseType },
      });
    });

    if (pendingPaymentsCount > 0) {
      items.push({
        type:     'payment_pending',
        id:       'payment_pending',
        title:    `${pendingPaymentsCount} pago${pendingPaymentsCount !== 1 ? 's' : ''} por aprobar`,
        subtitle: 'Comprobantes esperando revisión',
        date:     null,
        priority: 'high',
        meta:     { count: pendingPaymentsCount },
      });
    }

    if (pendingUnidentCount > 0) {
      items.push({
        type:     'unidentified_payment_pending',
        id:       'unidentified_payment_pending',
        title:    `${pendingUnidentCount} pago${pendingUnidentCount !== 1 ? 's' : ''} sin identificar`,
        subtitle: 'Requieren asociación o archivo',
        date:     null,
        priority: 'medium',
        meta:     { count: pendingUnidentCount },
      });
    }

    staleClaims.forEach(c => {
      const days = _daysAgo(c.createdAt);
      items.push({
        type:     'claim_stale',
        id:       c._id,
        title:    c.title,
        subtitle: `Sin respuesta · ${c.owner?.name || '—'} · ${days} días`,
        date:     c.createdAt,
        priority: 'medium',
        meta:     { ownerId: c.owner?._id, ownerName: c.owner?.name, daysOpen: days },
      });
    });

    dueSalaries.forEach(s => {
      items.push({
        type:     'salary_due',
        id:       s._id,
        title:    `Sueldo pendiente · ${s.employee?.name || '—'}`,
        subtitle: `Período ${s.period} · $${(s.totalAmount || 0).toLocaleString('es-AR')}`,
        date:     null,
        priority: s.period === period ? 'high' : 'medium',
        meta: {
          period:       s.period,
          status:       s.status,
          totalAmount:  s.totalAmount,
          paidAmount:   s.paidAmount,
          employeeId:   s.employee?._id,
          employeeName: s.employee?.name,
        },
      });
    });

    const renditionMissing = !currentRendition || currentRendition.status === 'draft';
    if (renditionMissing && period) {
      items.push({
        type:     'rendition_due',
        id:       'rendition_due',
        title:    `Rendición ${period} no generada`,
        subtitle: currentRendition?.status === 'draft' ? 'Está en borrador' : 'Aún no fue iniciada',
        date:     null,
        priority: 'medium',
        meta:     { period, renditionStatus: currentRendition?.status || null },
      });
    }

    if (pendingAccessReqsCount > 0) {
      items.push({
        type:     'access_request_pending',
        id:       'access_request_pending',
        title:    `${pendingAccessReqsCount} solicitud${pendingAccessReqsCount !== 1 ? 'es' : ''} de acceso`,
        subtitle: 'Propietarios esperando aprobación',
        date:     null,
        priority: 'low',
        meta:     { count: pendingAccessReqsCount },
      });
    }

    adminTasks.forEach(t => {
      items.push({
        type:     'admin_task',
        id:       t._id,
        title:    t.title,
        subtitle: t.notes || '',
        date:     t.dueDate || null,
        priority: t.priority,
        meta:     { notes: t.notes, dueDate: t.dueDate },
      });
    });

    providersWithExpiry.forEach(p => {
      for (const doc of p.documents || []) {
        if (!doc.expirationDate) continue;
        const expDate = new Date(doc.expirationDate);
        if (expDate > in30) continue;
        const expired  = expDate < today;
        const label    = doc.title || doc.filename || 'Documento';
        const dias     = Math.ceil(Math.abs(expDate - today) / (1000 * 60 * 60 * 24));
        items.push({
          type:     'provider_doc_expiry',
          id:       `provider_doc_${p._id}_${label}`,
          title:    expired
            ? `${p.name} — ${label} vencido`
            : `${p.name} — ${label} por vencer`,
          subtitle: expired
            ? `Venció hace ${dias} día${dias !== 1 ? 's' : ''}`
            : `Vence en ${dias} día${dias !== 1 ? 's' : ''}`,
          date:     expDate,
          priority: expired ? 'high' : 'medium',
          meta:     { providerId: p._id, providerName: p.name, docLabel: label, expired },
        });
      }
    });

    items.sort((a, b) => {
      const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pd !== 0) return pd;
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    });

    res.json({
      success: true,
      data: {
        items,
        summary: {
          total:  items.length,
          high:   items.filter(i => i.priority === 'high').length,
          medium: items.filter(i => i.priority === 'medium').length,
          low:    items.filter(i => i.priority === 'low').length,
          period,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.createTask = async (req, res, next) => {
  try {
    const { title, notes, dueDate, priority } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'El título es obligatorio.' });
    }
    const task = await AdminTask.create({
      organization: req.orgId,
      title:        title.trim(),
      notes:        notes?.trim(),
      dueDate:      dueDate || undefined,
      priority:     priority || 'medium',
      createdBy:    req.user._id,
    });
    res.status(201).json({ success: true, data: task });
  } catch (err) {
    next(err);
  }
};

exports.completeTask = async (req, res, next) => {
  try {
    const task = await AdminTask.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId },
      { status: 'done', completedBy: req.user._id, completedAt: new Date() },
      { new: true }
    );
    if (!task) {
      return res.status(404).json({ success: false, message: 'Tarea no encontrada.' });
    }
    res.json({ success: true, data: task });
  } catch (err) {
    next(err);
  }
};

exports.deleteTask = async (req, res, next) => {
  try {
    const task = await AdminTask.findOneAndDelete({ _id: req.params.id, organization: req.orgId });
    if (!task) {
      return res.status(404).json({ success: false, message: 'Tarea no encontrada.' });
    }
    res.json({ success: true, message: 'Tarea eliminada.' });
  } catch (err) {
    next(err);
  }
};
