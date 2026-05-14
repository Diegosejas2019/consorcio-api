const PaymentPlan             = require('../models/PaymentPlan');
const PaymentPlanInstallment  = require('../models/PaymentPlanInstallment');
const Payment                 = require('../models/Payment');
const Organization            = require('../models/Organization');
const User                    = require('../models/User');
const OrganizationMember      = require('../models/OrganizationMember');
const receiptService          = require('../services/receiptService');
const {
  buildPlanDebtSnapshot,
  markDebtItemsIncluded,
  releaseDebtItemsFromPlan,
} = require('../services/paymentPlanDebtService');
const logger                  = require('../config/logger');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ── Helpers ────────────────────────────────────────────────────

const calcInterest = (originalAmount, interestType, interestValue) => {
  if (!interestType || interestType === 'none') return 0;
  if (interestType === 'percentage') return Math.round(originalAmount * (interestValue / 100) * 100) / 100;
  if (interestType === 'fixed') return interestValue;
  return 0;
};

const generateInstallmentDates = (startDate, count) => {
  const dates = [];
  const base = new Date(startDate);
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setMonth(d.getMonth() + i);
    dates.push(d);
  }
  return dates;
};

const ACTIVE_PLAN_STATUSES = ['requested', 'approved', 'active'];

const installmentStatusLabel = (status) => ({
  pending:   'Pendiente',
  paid:      'Pagada',
  overdue:   'Vencida',
  cancelled: 'Cancelada',
}[status] ?? status);

const planStatusLabel = (status) => ({
  requested:  'Solicitado',
  approved:   'Aprobado',
  active:     'Activo',
  completed:  'Completado',
  rejected:   'Rechazado',
  cancelled:  'Cancelado',
  defaulted:  'Incumplido',
}[status] ?? status);

const formatPlan = (plan, installments = []) => {
  const paidInstallments   = installments.filter(i => i.status === 'paid').length;
  const pendingInstallments = installments.filter(i => ['pending', 'overdue'].includes(i.status));
  const totalPaid = installments
    .filter(i => i.status === 'paid')
    .reduce((sum, i) => sum + i.amount, 0);
  const remainingBalance = (plan.totalAmount || 0) - totalPaid;
  const nextDue = pendingInstallments
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0] || null;

  return {
    ...plan.toObject ? plan.toObject() : plan,
    statusLabel:        planStatusLabel(plan.status),
    paidInstallments,
    totalInstallments:  plan.installmentsCount || installments.length,
    totalPaid,
    remainingBalance:   Math.max(0, remainingBalance),
    nextDueDate:        nextDue?.dueDate || null,
    nextDueAmount:      nextDue?.amount || null,
    installments:       installments.map(i => ({
      ...i.toObject ? i.toObject() : i,
      statusLabel: installmentStatusLabel(i.status),
    })),
  };
};

// ── POST /api/payment-plans/request (owner) ────────────────────
exports.requestPlan = async (req, res, next) => {
  try {
    const { includedPeriods = [], extraordinaryItems = [], balanceDebt, balanceUnitIds, debtItemIds, currency, requestComment } = req.body;
    if (currency && currency !== 'ARS') {
      return res.status(400).json({ success: false, message: 'GestionAr solo admite importes en pesos argentinos.' });
    }

    if (!Array.isArray(includedPeriods)) {
      return res.status(400).json({ success: false, message: 'Debes incluir al menos un período en la solicitud.' });
    }
    for (const p of includedPeriods) {
      if (!p.month || !PERIOD_RE.test(p.month)) {
        return res.status(400).json({ success: false, message: `Período con formato inválido: ${p.month}.` });
      }
    }

    const existing = await PaymentPlan.findOne({
      organization: req.orgId,
      owner:        req.ownerId,
      status:       { $in: ACTIVE_PLAN_STATUSES },
      isActive:     true,
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Ya tenés un plan de pagos activo o pendiente de aprobación.',
      });
    }

    const snapshot = await buildPlanDebtSnapshot({
      organizationId: req.orgId,
      ownerId: req.ownerId,
      selection: { includedPeriods, extraordinaryItems, balanceDebt, balanceUnitIds, debtItemIds },
    });
    if (!snapshot || snapshot.originalDebtAmount <= 0) {
      return res.status(400).json({ success: false, message: 'SeleccionÃ¡ al menos una deuda disponible para incluir en el plan.' });
    }

    const plan = await PaymentPlan.create({
      organization:       req.orgId,
      owner:              req.ownerId,
      requestedBy:        'owner',
      status:             'requested',
      currency:           'ARS',
      originalDebtAmount: snapshot.originalDebtAmount,
      interestType:       'none',
      interestValue:      0,
      interestAmount:     0,
      totalAmount:        snapshot.originalDebtAmount,
      includedPeriods:    snapshot.includedPeriods,
      balanceDebt:        snapshot.balanceDebt,
      extraordinaryItems: snapshot.extraordinaryItems,
      debtSnapshot:       snapshot.debtSnapshot,
      requestComment: requestComment?.trim() || undefined,
      createdBy:      req.user._id,
    });
    await markDebtItemsIncluded(snapshot.debtSnapshot);

    res.status(201).json({
      success: true,
      message: 'Solicitud de plan de pagos enviada. El administrador la revisará a la brevedad.',
      data:    { plan },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/payment-plans/my (owner) ─────────────────────────
exports.getMyPlans = async (req, res, next) => {
  try {
    const plans = await PaymentPlan.find({
      organization: req.orgId,
      owner:        req.ownerId,
      isActive:     true,
    }).sort({ createdAt: -1 }).lean();

    const planIds = plans.map(p => p._id);
    const installments = await PaymentPlanInstallment.find({
      paymentPlan: { $in: planIds },
    }).sort({ installmentNumber: 1 }).lean();

    const installmentsByPlan = {};
    installments.forEach(i => {
      const key = i.paymentPlan.toString();
      (installmentsByPlan[key] ||= []).push(i);
    });

    const result = plans.map(plan => {
      const planInstallments = installmentsByPlan[plan._id.toString()] || [];
      const paidInstallments = planInstallments.filter(i => i.status === 'paid').length;
      const pendingInstallments = planInstallments.filter(i => ['pending', 'overdue'].includes(i.status));
      const totalPaid = planInstallments.filter(i => i.status === 'paid').reduce((sum, i) => sum + i.amount, 0);
      const nextDue = pendingInstallments.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0] || null;

      return {
        ...plan,
        statusLabel:       planStatusLabel(plan.status),
        paidInstallments,
        totalInstallments: plan.installmentsCount || planInstallments.length,
        totalPaid,
        remainingBalance:  Math.max(0, (plan.totalAmount || 0) - totalPaid),
        nextDueDate:       nextDue?.dueDate || null,
        nextDueAmount:     nextDue?.amount || null,
        installments:      planInstallments.map(i => ({
          ...i,
          statusLabel: installmentStatusLabel(i.status),
        })),
      };
    });

    res.json({ success: true, data: { plans: result } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/admin/payment-plans (admin) ──────────────────────
exports.listPlans = async (req, res, next) => {
  try {
    const { status, ownerId, page = 1, limit = 20 } = req.query;

    const filter = { organization: req.orgId, isActive: true };
    if (status) filter.status = status;
    if (ownerId) filter.owner = ownerId;

    const [plans, total] = await Promise.all([
      PaymentPlan.find(filter)
        .populate('owner', 'name email unit')
        .populate('approvedBy', 'name')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      PaymentPlan.countDocuments(filter),
    ]);

    const planIds = plans.map(p => p._id);
    const installments = await PaymentPlanInstallment.find({
      paymentPlan: { $in: planIds },
    }).sort({ installmentNumber: 1 }).lean();

    const installmentsByPlan = {};
    installments.forEach(i => {
      const key = i.paymentPlan.toString();
      (installmentsByPlan[key] ||= []).push(i);
    });

    const result = plans.map(plan => {
      const planInstallments = installmentsByPlan[plan._id.toString()] || [];
      const paidInstallments = planInstallments.filter(i => i.status === 'paid').length;
      const totalPaid = planInstallments.filter(i => i.status === 'paid').reduce((sum, i) => sum + i.amount, 0);
      return {
        ...plan,
        statusLabel:       planStatusLabel(plan.status),
        paidInstallments,
        totalInstallments: plan.installmentsCount || planInstallments.length,
        totalPaid,
        remainingBalance:  Math.max(0, (plan.totalAmount || 0) - totalPaid),
      };
    });

    res.json({
      success: true,
      data:    { plans: result },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/admin/payment-plans/:id (admin) ──────────────────
exports.getPlan = async (req, res, next) => {
  try {
    const plan = await PaymentPlan.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('owner', 'name email unit')
      .populate('approvedBy', 'name')
      .populate('rejectedBy', 'name')
      .populate('cancelledBy', 'name')
      .populate('createdBy', 'name');

    if (!plan) return res.status(404).json({ success: false, message: 'Plan no encontrado.' });

    const installments = await PaymentPlanInstallment.find({ paymentPlan: plan._id })
      .sort({ installmentNumber: 1 });

    res.json({ success: true, data: { plan: formatPlan(plan, installments) } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/admin/payment-plans/:id/approve (admin) ─────────
exports.approvePlan = async (req, res, next) => {
  try {
    const { installmentsCount, startDate, interestType, interestValue, adminComment } = req.body;

    if (!installmentsCount || Number(installmentsCount) < 1) {
      return res.status(400).json({ success: false, message: 'La cantidad de cuotas debe ser al menos 1.' });
    }
    if (!startDate) {
      return res.status(400).json({ success: false, message: 'La fecha del primer vencimiento es obligatoria.' });
    }

    const plan = await PaymentPlan.findOne({ _id: req.params.id, organization: req.orgId });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan no encontrado.' });
    if (plan.status !== 'requested') {
      return res.status(400).json({ success: false, message: `El plan no está en estado "Solicitado" (estado actual: ${planStatusLabel(plan.status)}).` });
    }

    if (!plan.debtSnapshot || (
      !(plan.debtSnapshot.periods || []).length
      && !(plan.debtSnapshot.extraordinaryItems || []).length
      && !(plan.debtSnapshot.balanceItems || []).length
      && !(plan.debtSnapshot.debtItems || []).length
    )) {
      const snapshot = await buildPlanDebtSnapshot({
        organizationId: req.orgId,
        ownerId: plan.owner,
        selection: {
          includedPeriods: plan.includedPeriods || [],
          extraordinaryItems: plan.extraordinaryItems || [],
          balanceDebt: plan.balanceDebt,
        },
        excludePlanId: plan._id,
      });
      if (snapshot && snapshot.originalDebtAmount > 0) {
        plan.originalDebtAmount = snapshot.originalDebtAmount;
        plan.totalAmount = snapshot.originalDebtAmount;
        plan.includedPeriods = snapshot.includedPeriods;
        plan.balanceDebt = snapshot.balanceDebt;
        plan.extraordinaryItems = snapshot.extraordinaryItems;
        plan.debtSnapshot = snapshot.debtSnapshot;
        await markDebtItemsIncluded(snapshot.debtSnapshot);
      }
    }
    if (!plan.originalDebtAmount || Number(plan.originalDebtAmount) <= 0) {
      return res.status(400).json({ success: false, message: 'El plan no tiene deuda disponible incluida.' });
    }

    const count          = Number(installmentsCount);
    const iType          = interestType || 'none';
    const iValue         = Number(interestValue || 0);
    const interestAmount = calcInterest(plan.originalDebtAmount, iType, iValue);
    const totalAmount    = plan.originalDebtAmount + interestAmount;
    const installmentAmt = Math.round((totalAmount / count) * 100) / 100;

    const dueDates = generateInstallmentDates(new Date(startDate), count);

    plan.status           = 'active';
    plan.installmentsCount = count;
    plan.startDate        = new Date(startDate);
    plan.interestType     = iType;
    plan.interestValue    = iValue;
    plan.interestAmount   = interestAmount;
    plan.totalAmount      = totalAmount;
    plan.adminComment     = adminComment?.trim() || undefined;
    plan.approvedBy       = req.user._id;
    plan.approvedAt       = new Date();
    await plan.save();

    const installmentsData = dueDates.map((dueDate, i) => ({
      organization:     req.orgId,
      paymentPlan:      plan._id,
      owner:            plan.owner,
      installmentNumber: i + 1,
      dueDate,
      amount:           installmentAmt,
      currency:         plan.currency,
      status:           'pending',
      createdBy:        req.user._id,
    }));

    await PaymentPlanInstallment.insertMany(installmentsData);

    const installments = await PaymentPlanInstallment.find({ paymentPlan: plan._id }).sort({ installmentNumber: 1 });
    await plan.populate('owner', 'name email unit');

    logger.info(`[paymentPlan] Plan ${plan._id} aprobado por ${req.user._id} — ${count} cuota(s) de $${installmentAmt}`);
    res.json({
      success: true,
      message: `Plan aprobado. Se generaron ${count} cuota(s) de $${installmentAmt}.`,
      data:    { plan: formatPlan(plan, installments) },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/admin/payment-plans/:id/reject (admin) ──────────
exports.rejectPlan = async (req, res, next) => {
  try {
    const { rejectionReason } = req.body;
    if (!rejectionReason?.trim()) {
      return res.status(400).json({ success: false, message: 'El motivo de rechazo es obligatorio.' });
    }

    const plan = await PaymentPlan.findOne({ _id: req.params.id, organization: req.orgId });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan no encontrado.' });
    if (plan.status !== 'requested') {
      return res.status(400).json({ success: false, message: `Solo se pueden rechazar planes en estado "Solicitado" (estado actual: ${planStatusLabel(plan.status)}).` });
    }

    plan.status          = 'rejected';
    plan.rejectionReason = rejectionReason.trim();
    plan.rejectedBy      = req.user._id;
    plan.rejectedAt      = new Date();
    await plan.save();
    await releaseDebtItemsFromPlan(plan);

    logger.info(`[paymentPlan] Plan ${plan._id} rechazado por ${req.user._id}`);
    res.json({ success: true, message: 'Plan rechazado.', data: { plan } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/admin/payment-plans (admin) — plan manual ───────
exports.createPlan = async (req, res, next) => {
  try {
    const {
      ownerId,
      includedPeriods = [],
      extraordinaryItems = [],
      balanceDebt,
      balanceUnitIds,
      debtItemIds,
      originalDebtAmount,
      currency,
      installmentsCount,
      startDate,
      interestType,
      interestValue,
      adminComment,
      requestComment,
    } = req.body;

    if (!ownerId) {
      return res.status(400).json({ success: false, message: 'El propietario es obligatorio.' });
    }
    if (currency && currency !== 'ARS') {
      return res.status(400).json({ success: false, message: 'GestionAr solo admite importes en pesos argentinos.' });
    }
    if (!Array.isArray(includedPeriods || [])) {
      return res.status(400).json({ success: false, message: 'Debes incluir al menos un período.' });
    }
    for (const p of includedPeriods) {
      if (!p.month || !PERIOD_RE.test(p.month)) {
        return res.status(400).json({ success: false, message: `Período con formato inválido: ${p.month}.` });
      }
    }
    if (!installmentsCount || Number(installmentsCount) < 1) {
      return res.status(400).json({ success: false, message: 'La cantidad de cuotas debe ser al menos 1.' });
    }
    if (!startDate) {
      return res.status(400).json({ success: false, message: 'La fecha del primer vencimiento es obligatoria.' });
    }

    const member = await OrganizationMember.findOne({
      user:         ownerId,
      organization: req.orgId,
      role:         'owner',
      isActive:     true,
    });
    if (!member) {
      return res.status(404).json({ success: false, message: 'Propietario no encontrado en esta organización.' });
    }

    const existing = await PaymentPlan.findOne({
      organization: req.orgId,
      owner:        ownerId,
      status:       { $in: ACTIVE_PLAN_STATUSES },
      isActive:     true,
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'El propietario ya tiene un plan activo o pendiente de aprobación.',
      });
    }

    const count          = Number(installmentsCount);
    const iType          = interestType || 'none';
    const iValue         = Number(interestValue || 0);
    const snapshot       = await buildPlanDebtSnapshot({
      organizationId: req.orgId,
      ownerId,
      selection: { includedPeriods, extraordinaryItems, balanceDebt, balanceUnitIds, debtItemIds },
    });
    if (!snapshot || snapshot.originalDebtAmount <= 0) {
      return res.status(400).json({ success: false, message: 'SeleccionÃ¡ al menos una deuda disponible para incluir en el plan.' });
    }
    const origAmount     = Number(snapshot.originalDebtAmount);
    const interestAmount = calcInterest(origAmount, iType, iValue);
    const totalAmount    = origAmount + interestAmount;
    const installmentAmt = Math.round((totalAmount / count) * 100) / 100;

    const plan = await PaymentPlan.create({
      organization:      req.orgId,
      owner:             ownerId,
      requestedBy:       'admin',
      status:            'active',
      currency:          'ARS',
      originalDebtAmount: origAmount,
      interestType:      iType,
      interestValue:     iValue,
      interestAmount,
      totalAmount,
      installmentsCount: count,
      startDate:         new Date(startDate),
      frequency:         'monthly',
      includedPeriods:   snapshot.includedPeriods,
      balanceDebt:       snapshot.balanceDebt,
      extraordinaryItems: snapshot.extraordinaryItems,
      debtSnapshot:      snapshot.debtSnapshot,
      requestComment: requestComment?.trim() || undefined,
      adminComment:   adminComment?.trim() || undefined,
      createdBy:      req.user._id,
      approvedBy:     req.user._id,
      approvedAt:     new Date(),
    });

    const dueDates = generateInstallmentDates(new Date(startDate), count);
    const installmentsData = dueDates.map((dueDate, i) => ({
      organization:     req.orgId,
      paymentPlan:      plan._id,
      owner:            ownerId,
      installmentNumber: i + 1,
      dueDate,
      amount:           installmentAmt,
      currency:         plan.currency,
      status:           'pending',
      createdBy:        req.user._id,
    }));

    await PaymentPlanInstallment.insertMany(installmentsData);
    await markDebtItemsIncluded(snapshot.debtSnapshot);

    const installments = await PaymentPlanInstallment.find({ paymentPlan: plan._id }).sort({ installmentNumber: 1 });
    await plan.populate('owner', 'name email unit');

    logger.info(`[paymentPlan] Plan manual ${plan._id} creado por ${req.user._id} para owner ${ownerId}`);
    res.status(201).json({
      success: true,
      message: `Plan de pagos creado con ${count} cuota(s) de $${installmentAmt}.`,
      data:    { plan: formatPlan(plan, installments) },
    });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/admin/payment-plans/:id/cancel (admin) ─────────
exports.cancelPlan = async (req, res, next) => {
  try {
    const plan = await PaymentPlan.findOne({ _id: req.params.id, organization: req.orgId });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan no encontrado.' });
    if (['completed', 'rejected', 'cancelled'].includes(plan.status)) {
      return res.status(400).json({ success: false, message: `El plan ya está ${planStatusLabel(plan.status).toLowerCase()}.` });
    }

    plan.status      = 'cancelled';
    plan.cancelledBy = req.user._id;
    plan.cancelledAt = new Date();
    await plan.save();

    await PaymentPlanInstallment.updateMany(
      { paymentPlan: plan._id, status: { $in: ['pending', 'overdue'] } },
      { $set: { status: 'cancelled' } }
    );
    await releaseDebtItemsFromPlan(plan);

    logger.info(`[paymentPlan] Plan ${plan._id} cancelado por ${req.user._id}`);
    res.json({ success: true, message: 'Plan cancelado. Las cuotas pendientes fueron canceladas.' });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/admin/payment-plans/:id (admin) ─────────────────────────
exports.deletePlan = async (req, res, next) => {
  try {
    const plan = await PaymentPlan.findOne({ _id: req.params.id, organization: req.orgId });
    if (!plan || !plan.isActive) {
      return res.status(404).json({ success: false, message: 'Plan no encontrado.' });
    }

    const hasPaidInstallments = await PaymentPlanInstallment.exists({
      paymentPlan: plan._id,
      $or: [{ status: 'paid' }, { paymentId: { $exists: true, $ne: null } }],
    });
    if (hasPaidInstallments) {
      return res.status(400).json({
        success: false,
        message: 'No se puede eliminar un plan con cuotas pagadas. Podés cancelarlo para conservar el historial.',
      });
    }

    plan.isActive = false;
    plan.deletedAt = new Date();
    plan.cancelledBy = req.user._id;
    plan.cancelledAt = new Date();
    if (!['rejected', 'cancelled', 'completed'].includes(plan.status)) {
      plan.status = 'cancelled';
    }
    await plan.save();

    await PaymentPlanInstallment.updateMany(
      { paymentPlan: plan._id, status: { $in: ['pending', 'overdue'] } },
      { $set: { status: 'cancelled' } }
    );
    await releaseDebtItemsFromPlan(plan);

    logger.info(`[paymentPlan] Plan ${plan._id} eliminado por ${req.user._id}`);
    res.json({ success: true, message: 'Plan eliminado correctamente.' });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/admin/payment-plan-installments/:id/register-payment (admin) ─
exports.registerInstallmentPayment = async (req, res, next) => {
  try {
    const installment = await PaymentPlanInstallment.findOne({
      _id:          req.params.id,
      organization: req.orgId,
    });
    if (!installment) return res.status(404).json({ success: false, message: 'Cuota no encontrada.' });
    if (installment.status === 'paid') {
      return res.status(400).json({ success: false, message: 'Esta cuota ya fue pagada.' });
    }
    if (installment.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'Esta cuota está cancelada.' });
    }

    const plan = await PaymentPlan.findOne({ _id: installment.paymentPlan, organization: req.orgId });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan no encontrado.' });

    const payment = await Payment.create({
      organization:  req.orgId,
      owner:         installment.owner,
      amount:        installment.amount,
      status:        'approved',
      paymentMethod: 'manual',
      type:          'installment',
      installmentId: installment._id,
      ownerNote:     `Cuota ${installment.installmentNumber} de ${plan.installmentsCount} — Plan de pagos`,
      createdBy:     req.user._id,
      approvedBy:    req.user._id,
      reviewedBy:    req.user._id,
      reviewedAt:    new Date(),
    });

    installment.status    = 'paid';
    installment.paidAt    = new Date();
    installment.paymentId = payment._id;
    await installment.save();

    // Verificar si todas las cuotas del plan están pagas
    const allInstallments = await PaymentPlanInstallment.find({ paymentPlan: plan._id });
    const allPaid = allInstallments.every(i => i.status === 'paid' || i.status === 'cancelled');
    const anyActivePaid = allInstallments.some(i => i.status === 'paid');

    if (allPaid && anyActivePaid) {
      plan.status = 'completed';
      await plan.save();
      logger.info(`[paymentPlan] Plan ${plan._id} completado — todas las cuotas pagas`);
    }

    // Generar recibo de forma asíncrona
    receiptService.generateAndStoreReceipt(payment._id)
      .then(async (updatedPayment) => {
        installment.receiptId = updatedPayment.receiptNumber;
        await installment.save();
      })
      .catch(err => logger.error(`[paymentPlan] Error generando recibo para cuota ${installment._id}: ${err.message}`));

    logger.info(`[paymentPlan] Cuota ${installment._id} pagada — pago ${payment._id}`);
    res.json({
      success: true,
      message: 'Pago de cuota registrado correctamente.',
      data:    {
        installment: { ...installment.toObject(), statusLabel: 'Pagada' },
        payment,
        planCompleted: plan.status === 'completed',
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/payment-plans/installments/:id/pay (owner) ───────
exports.submitInstallmentPayment = async (req, res, next) => {
  try {
    const installment = await PaymentPlanInstallment.findOne({
      _id:          req.params.id,
      organization: req.orgId,
      owner:        req.ownerId,
    });
    if (!installment) return res.status(404).json({ success: false, message: 'Cuota no encontrada.' });
    if (installment.status === 'paid') {
      return res.status(400).json({ success: false, message: 'Esta cuota ya fue pagada.' });
    }
    if (installment.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'Esta cuota está cancelada.' });
    }

    const existingPending = await Payment.findOne({
      installmentId: installment._id,
      status:        'pending',
    });
    if (existingPending) {
      return res.status(400).json({ success: false, message: 'Ya existe un comprobante pendiente de revisión para esta cuota.' });
    }

    const plan = await PaymentPlan.findOne({ _id: installment.paymentPlan, organization: req.orgId });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan no encontrado.' });

    const receiptData = req.file ? {
      url:      req.file.path,
      publicId: req.file.filename,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size:     req.file.size,
    } : undefined;

    const payment = await Payment.create({
      organization:  req.orgId,
      owner:         req.ownerId,
      amount:        installment.amount,
      status:        'pending',
      paymentMethod: 'manual',
      type:          'installment',
      installmentId: installment._id,
      ownerNote:     `Cuota ${installment.installmentNumber} de ${plan.installmentsCount} — Plan de pagos`,
      createdBy:     req.user._id,
      receipt:       receiptData,
    });

    logger.info(`[paymentPlan] Owner ${req.ownerId} subió comprobante para cuota ${installment._id} — pago ${payment._id}`);
    res.status(201).json({
      success: true,
      message: 'Comprobante enviado. Quedará pendiente de revisión por el administrador.',
      data: { payment },
    });
  } catch (err) {
    next(err);
  }
};

