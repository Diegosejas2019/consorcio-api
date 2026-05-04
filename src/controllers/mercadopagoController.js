const { MercadoPagoConfig, Preference, Payment: MPPayment } = require('mercadopago');
const crypto       = require('crypto');
const Payment            = require('../models/Payment');
const User               = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Unit               = require('../models/Unit');
const Expense            = require('../models/Expense');
const Organization = require('../models/Organization');
const { calcUnitFee } = require('./unitController');
const { calculateExtraordinaryAmountForOwner } = require('../services/expenseService');
const emailService   = require('../services/emailService');
const firebaseService = require('../services/firebaseService');
const receiptService = require('../services/receiptService');
const logger  = require('../config/logger');

async function settleOwnerAccount(payment) {
  const ownerId = payment.owner?._id || payment.owner;

  if (payment.type === 'balance') {
    const updatedMember = await OrganizationMember.findOneAndUpdate(
      { user: ownerId, organization: payment.organization, role: 'owner' },
      { $inc: { balance: payment.amount } },
      { new: true }
    );
    if ((updatedMember?.balance ?? -1) >= 0) {
      await OrganizationMember.updateOne(
        { user: ownerId, organization: payment.organization, role: 'owner' },
        { isDebtor: false }
      );
    }
    return;
  }

  if (payment.type === 'extraordinary') {
    return;
  }

  await OrganizationMember.updateOne(
    { user: ownerId, organization: payment.organization, role: 'owner' },
    { isDebtor: false, balance: 0 }
  );
}

async function generateReceiptsForApprovedMPPayments(paymentList) {
  const approvedPayments = paymentList.filter(payment => payment.status === 'approved' && !payment.systemReceipt?.url);
  const results = await Promise.allSettled(
    approvedPayments.map(payment => receiptService.generateAndStoreReceipt(payment._id))
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error(`[MercadoPago] Error generando recibo ${approvedPayments[index]?._id}: ${result.reason?.message}`);
    }
  });
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {}
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }
  return value ? [value] : [];
}

function parseExternalReference(reference) {
  const parts = String(reference || '').split('|');
  const [orgId, ownerId] = parts;
  if (!orgId || !ownerId) return null;

  if (parts[2] === 'v2') {
    return {
      orgId,
      ownerId,
      periods:          normalizeArray(parts[3]),
      extraordinaryIds: normalizeArray(parts[4]),
      balanceAmount:    Number(parts[5] || 0),
      version:          'v2',
    };
  }

  return {
    orgId,
    ownerId,
    periods:          normalizeArray(parts[2]),
    extraordinaryIds: [],
    balanceAmount:    0,
    version:          'legacy',
  };
}

async function getOwnerPaymentContext(orgId, ownerId) {
  const [org, membership, ownerUnits, allOrgUnits] = await Promise.all([
    Organization.findById(orgId),
    OrganizationMember.findOne({ user: ownerId, organization: orgId, role: 'owner' }).select('_id balance isDebtor'),
    Unit.find({ owner: ownerId, active: true, organization: orgId }).sort({ name: 1 }).lean(),
    Unit.find({ organization: orgId, active: true }).lean(),
  ]);
  const monthlyFee = org?.monthlyFee || 0;
  const unitAmount = ownerUnits.length > 0
    ? ownerUnits.reduce((sum, u) => sum + calcUnitFee(u, monthlyFee), 0)
    : monthlyFee;
  const unitsSnapshot = ownerUnits.map(u => u._id);
  const breakdownSnapshot = ownerUnits.map(u => ({
    unit:   u._id,
    name:   u.name,
    amount: calcUnitFee(u, monthlyFee),
  }));

  return { org, membership, ownerUnits, allOrgUnits, unitAmount, unitsSnapshot, breakdownSnapshot };
}

async function buildExtraordinaryItems({ orgId, ownerId, extraordinaryIds, ownerUnits, allOrgUnits }) {
  if (!extraordinaryIds.length) return [];

  const expenses = await Expense.find({
    _id:          { $in: extraordinaryIds },
    organization: orgId,
    expenseType:  'extraordinary',
    isChargeable: true,
    isActive:     { $ne: false },
  }).select('_id description amount extraordinaryBillingMode unitAmount appliesToAllOwners targetUnits').lean();

  if (expenses.length !== extraordinaryIds.length) {
    const err = new Error('Uno o más conceptos extraordinarios no son válidos.');
    err.statusCode = 400;
    throw err;
  }

  const alreadyPaid = await Payment.findOne({
    organization: orgId,
    owner:        ownerId,
    status:       { $in: ['pending', 'approved'] },
    'extraordinaryItems.expense': { $in: extraordinaryIds },
  });
  if (alreadyPaid) {
    const err = new Error('Uno o más conceptos extraordinarios ya tienen un pago activo.');
    err.statusCode = 400;
    throw err;
  }

  return expenses.map(expense => {
    const { amountForOwner } = calculateExtraordinaryAmountForOwner(expense, ownerUnits, allOrgUnits);
    return { expense: expense._id, amount: amountForOwner, description: expense.description };
  }).filter(item => item.amount > 0);
}

async function createPaymentsFromMPReference(mpData) {
  const ref = parseExternalReference(mpData.external_reference);
  if (!ref?.orgId || !ref?.ownerId) {
    logger.warn(`MP reconcile: external_reference incompleto: ${mpData.external_reference}`);
    return [];
  }

  const ctx = await getOwnerPaymentContext(ref.orgId, ref.ownerId);
  const docs = [];

  if (ref.periods.length) {
    const existingActive = await Payment.find({
      organization: ref.orgId,
      owner:        ref.ownerId,
      month:        { $in: ref.periods },
      status:       { $in: ['pending', 'approved'] },
    }).select('month');
    const activeSet = new Set(existingActive.map(p => p.month));
    const newMonths = ref.periods.filter(m => !activeSet.has(m));

    docs.push(...newMonths.map(month => ({
      organization:   ref.orgId,
      owner:          ref.ownerId,
      membership:     ctx.membership?._id,
      month,
      amount:         ctx.unitAmount,
      status:         'pending',
      paymentMethod:  'mercadopago',
      type:           'monthly',
      mpPreferenceId: mpData.preference_id,
      units:          ctx.unitsSnapshot,
      breakdown:      ctx.breakdownSnapshot,
    })));
  }

  if (ref.extraordinaryIds.length) {
    const extraordinaryItems = await buildExtraordinaryItems({
      orgId: ref.orgId,
      ownerId: ref.ownerId,
      extraordinaryIds: ref.extraordinaryIds,
      ownerUnits: ctx.ownerUnits,
      allOrgUnits: ctx.allOrgUnits,
    });
    const amount = extraordinaryItems.reduce((sum, item) => sum + item.amount, 0);
    if (amount > 0) {
      docs.push({
        organization:      ref.orgId,
        owner:             ref.ownerId,
        membership:        ctx.membership?._id,
        amount,
        status:            'pending',
        paymentMethod:     'mercadopago',
        type:              'extraordinary',
        mpPreferenceId:    mpData.preference_id,
        units:             ctx.unitsSnapshot,
        breakdown:         ctx.breakdownSnapshot,
        extraordinaryItems: extraordinaryItems.map(({ expense, amount }) => ({ expense, amount })),
      });
    }
  }

  if (ref.balanceAmount > 0) {
    const pendingBalance = await Payment.findOne({
      organization: ref.orgId,
      owner:        ref.ownerId,
      type:         'balance',
      status:       'pending',
    });
    if (!pendingBalance) {
      docs.push({
        organization:   ref.orgId,
        owner:          ref.ownerId,
        membership:     ctx.membership?._id,
        amount:         ref.balanceAmount,
        status:         'pending',
        paymentMethod:  'mercadopago',
        type:           'balance',
        mpPreferenceId: mpData.preference_id,
      });
    }
  }

  if (!docs.length) {
    logger.info(`MP reconcile: no hay conceptos nuevos para ${ref.ownerId}`);
    return [];
  }

  const created = await Payment.insertMany(docs);
  logger.info(`MP reconcile: creados ${created.length} registro(s) desde external_reference - ${ref.ownerId}`);

  return Payment.find({ _id: { $in: created.map(p => p._id) } })
    .populate('owner', 'name email unit fcmToken');
}

async function ensurePaymentsFromMPData(mpData) {
  if (!mpData?.external_reference || ['rejected', 'cancelled'].includes(mpData.status)) {
    return [];
  }

  const ref = parseExternalReference(mpData.external_reference);
  const refOrgId = ref?.orgId;
  const refOwnerId = ref?.ownerId;
  const refMonths = ref?.periods || [];

  if (!refOrgId || !refOwnerId || (refMonths.length === 0 && !ref?.extraordinaryIds.length && !ref?.balanceAmount)) {
    logger.warn(`MP reconcile: external_reference incompleto: ${mpData.external_reference}`);
    return [];
  }

  let paymentList = [];
  if (refMonths.length) {
    paymentList = await Payment.find({
      organization:  refOrgId,
      owner:         refOwnerId,
      month:         { $in: refMonths },
      paymentMethod: 'mercadopago',
      status:        { $in: ['pending', 'approved'] },
    }).populate('owner', 'name email unit fcmToken');
  }

  if (!paymentList.length && mpData.preference_id) {
    paymentList = await Payment.find({
      mpPreferenceId: mpData.preference_id,
      status:         { $in: ['pending', 'approved'] },
    }).populate('owner', 'name email unit fcmToken');
  }

  if (!paymentList.length && ref.version === 'v2') {
    paymentList = await createPaymentsFromMPReference(mpData);
  }

  if (!paymentList.length) {
    const existingActive = await Payment.find({
      organization: refOrgId,
      owner:        refOwnerId,
      month:        { $in: refMonths },
      status:       { $in: ['pending', 'approved'] },
    }).select('month');
    const activeSet = new Set(existingActive.map(p => p.month));
    const newMonths = refMonths.filter(m => !activeSet.has(m));

    if (!newMonths.length) {
      logger.info(`MP reconcile: todos los períodos ya tienen pago activo para ${refOwnerId}`);
      return [];
    }

    const [refOrg, refMembership] = await Promise.all([
      Organization.findById(refOrgId),
      OrganizationMember.findOne({ user: refOwnerId, organization: refOrgId, role: 'owner' }).select('_id'),
    ]);
    const monthlyFee = refOrg?.monthlyFee || 0;
    const refUnits = await Unit.find({ owner: refOwnerId, active: true, organization: refOrgId }).sort({ name: 1 });
    const unitAmount = refUnits.length > 0
      ? refUnits.reduce((sum, u) => sum + calcUnitFee(u, monthlyFee), 0)
      : monthlyFee;
    const unitsSnapshot = refUnits.map(u => u._id);
    const breakdownSnapshot = refUnits.map(u => ({
      unit:   u._id,
      name:   u.name,
      amount: calcUnitFee(u, monthlyFee),
    }));

    const created = await Payment.insertMany(
      newMonths.map(month => ({
        organization:   refOrgId,
        owner:          refOwnerId,
        membership:     refMembership?._id,
        month,
        amount:         unitAmount,
        status:         'pending',
        paymentMethod:  'mercadopago',
        type:           'monthly',
        mpPreferenceId: mpData.preference_id,
        units:          unitsSnapshot,
        breakdown:      breakdownSnapshot,
      }))
    );

    paymentList = await Payment.find({ _id: { $in: created.map(p => p._id) } })
      .populate('owner', 'name email unit fcmToken');

    logger.info(`MP reconcile: creados ${created.length} registro(s) desde external_reference - ${refOwnerId}`);
  }

  for (const payment of paymentList) {
    payment.mpPaymentId = String(mpData.id);
    payment.mpStatus    = mpData.status;
    payment.mpDetail    = mpData.status_detail;
    if (mpData.status === 'approved') {
      payment.status     = 'approved';
      payment.reviewedAt = payment.reviewedAt || new Date();
    } else if (['rejected', 'cancelled'].includes(mpData.status)) {
      payment.status        = 'rejected';
      payment.rejectionNote = `Rechazado por MercadoPago: ${mpData.status_detail}`;
    }
  }
  await Promise.all(paymentList.map(p => p.save()));
  await Promise.all(paymentList.filter(p => p.status === 'approved').map(settleOwnerAccount));
  await generateReceiptsForApprovedMPPayments(paymentList);

  return paymentList;
}

// ── Helper: instancia MP con credenciales de la organización ──
async function getMPClient(orgId) {
  const org = await Organization.findById(orgId).select('+mpAccessToken');
  if (!org?.mpAccessToken) throw new Error('MercadoPago no configurado. Contactá al administrador.');
  return new MercadoPagoConfig({ accessToken: org.mpAccessToken });
}

// ── POST /api/mercadopago/preference — crear preferencia ──────
exports.createPreference = async (req, res, next) => {
  try {
    const org   = req.org;
    const owner = req.user;

    if (!org) return res.status(400).json({ success: false, message: 'Organización requerida.' });

    const monthlyFee = org.monthlyFee || org.feeAmount || 0;
    const v2Periods = normalizeArray(req.body?.periods);
    const v2ExtraordinaryIds = normalizeArray(req.body?.extraordinaryIds);
    const requestedBalanceAmount = Number(req.body?.balanceAmount || 0);

    if (v2Periods.length > 0 || v2ExtraordinaryIds.length > 0 || requestedBalanceAmount > 0) {
      const periodRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
      if (v2Periods.some(p => !periodRegex.test(p))) {
        return res.status(400).json({ success: false, message: 'Formato de período inválido.' });
      }

      const currentPeriod = org.feePeriodCode || new Date().toISOString().slice(0, 7);
      if (v2Periods.some(p => p > currentPeriod)) {
        return res.status(400).json({ success: false, message: 'No se pueden pagar períodos futuros.' });
      }

      const ctx = await getOwnerPaymentContext(req.orgId, owner._id);
      const items = [];
      let totalAmount = 0;
      let payablePeriods = [];
      let balanceAmount = 0;

      if (v2Periods.length > 0) {
        const existingActive = await Payment.find({
          organization: req.orgId,
          owner: owner._id,
          month: { $in: v2Periods },
          status: { $in: ['pending', 'approved'] },
        }).select('month');
        const activeSet = new Set(existingActive.map(p => p.month));
        payablePeriods = v2Periods.filter(p => !activeSet.has(p));
        const periodsAmount = ctx.unitAmount * payablePeriods.length;
        if (periodsAmount > 0) {
          totalAmount += periodsAmount;
          const periodLabel = payablePeriods.length === 1 ? payablePeriods[0] : `${payablePeriods.length} períodos`;
          items.push({
            id:          `fee-${payablePeriods[0]}-${payablePeriods.length}p-${owner._id}`,
            title:       `${org.feeLabel} ${periodLabel} — ${org.name}`,
            description: `${owner.name} — ${owner.unit || ''}`.trim(),
            quantity:    1,
            unit_price:  periodsAmount,
            currency_id: 'ARS',
          });
        }
      }

      if (v2ExtraordinaryIds.length > 0) {
        const extraordinaryItems = await buildExtraordinaryItems({
          orgId: req.orgId,
          ownerId: owner._id,
          extraordinaryIds: v2ExtraordinaryIds,
          ownerUnits: ctx.ownerUnits,
          allOrgUnits: ctx.allOrgUnits,
        });
        const extrasAmount = extraordinaryItems.reduce((sum, item) => sum + item.amount, 0);
        if (extrasAmount <= 0) {
          return res.status(400).json({ success: false, message: 'No hay importe extraordinario para pagar.' });
        }
        totalAmount += extrasAmount;
        items.push({
          id:          `extra-${v2ExtraordinaryIds.join('-')}`,
          title:       `Gasto extraordinario — ${org.name}`,
          description: extraordinaryItems.map(item => item.description).join(', '),
          quantity:    1,
          unit_price:  extrasAmount,
          currency_id: 'ARS',
        });
      }

      if (requestedBalanceAmount > 0) {
        const pendingBalance = await Payment.findOne({
          organization: req.orgId,
          owner:        owner._id,
          type:         'balance',
          status:       'pending',
        });
        if (pendingBalance) {
          return res.status(400).json({ success: false, message: 'Ya tenés un pago de saldo anterior pendiente.' });
        }
        const debt = Math.abs(Math.min(ctx.membership?.balance || owner.balance || 0, 0));
        if (debt <= 0) {
          return res.status(400).json({ success: false, message: 'No hay deuda inicial pendiente para pagar.' });
        }
        balanceAmount = Math.min(requestedBalanceAmount, debt);
        totalAmount += balanceAmount;
        items.push({
          id:          `balance-${owner._id}`,
          title:       `Saldo anterior — ${org.name}`,
          description: `${owner.name} — deuda inicial`,
          quantity:    1,
          unit_price:  balanceAmount,
          currency_id: 'ARS',
        });
      }

      if (totalAmount <= 0 || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Seleccioná al menos un concepto para pagar.' });
      }

      const client     = await getMPClient(req.orgId);
      const preference = new Preference(client);
      const appBaseUrl = process.env.APP_BASE_URL;
      const apiBaseUrl = process.env.API_BASE_URL || process.env.PUBLIC_API_BASE_URL || appBaseUrl;

      const preferenceData = {
        items,
        payer: {
          name:    owner.name.split(' ')[0],
          surname: owner.name.split(' ').slice(1).join(' '),
          email:   owner.email,
        },
        back_urls: {
          success: `${appBaseUrl}/pago/exitoso`,
          failure: `${appBaseUrl}/pago/fallido`,
          pending: `${appBaseUrl}/pago/pendiente`,
        },
        auto_return: 'approved',
        notification_url: `${apiBaseUrl}/api/mercadopago/webhook`,
        external_reference: `${req.orgId}|${owner._id}|v2|${payablePeriods.join(',')}|${v2ExtraordinaryIds.join(',')}|${balanceAmount}|${Date.now()}`,
        expires: true,
        expiration_date_to: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      };

      const result = await preference.create({ body: preferenceData });

      logger.info(`Preferencia MP creada: ${result.id} — ${owner.name} — $${totalAmount} [org: ${req.orgId}]`);

      return res.json({
        success: true,
        data: {
          preferenceId: result.id,
          initPoint:    result.init_point,
          sandboxUrl:   result.sandbox_init_point,
          periods:      payablePeriods,
          extraordinaryIds: v2ExtraordinaryIds,
          balanceAmount,
          totalAmount,
        },
      });
    }

    // Períodos a pagar: si se envían desde el frontend, usarlos; si no, el período vigente
    const rawPeriods = req.body?.periods;
    const periods    = Array.isArray(rawPeriods) && rawPeriods.length > 0
      ? rawPeriods
      : [org.feePeriodCode];

    // Validar formato de períodos
    const periodRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
    if (periods.some(p => !periodRegex.test(p))) {
      return res.status(400).json({ success: false, message: 'Formato de período inválido.' });
    }

    // Excluir períodos con pago activo
    const currentPeriod = org.feePeriodCode || new Date().toISOString().slice(0, 7);
    if (periods.some(p => p > currentPeriod)) {
      return res.status(400).json({ success: false, message: 'No se pueden pagar períodos futuros.' });
    }

    const existingActive = await Payment.find({
      organization: req.orgId,
      owner: owner._id,
      month: { $in: periods },
      status: { $in: ['pending', 'approved'] },
    }).select('month');
    const activeSet = new Set(existingActive.map(p => p.month));
    const payablePeriods = periods.filter(p => !activeSet.has(p));

    if (payablePeriods.length === 0) {
      return res.status(400).json({ success: false, message: 'Todos los períodos seleccionados ya tienen un pago activo.' });
    }

    // Calcular monto desde unidades activas del propietario
    const activeUnits = await Unit.find({ owner: owner._id, active: true, organization: req.orgId }).sort({ name: 1 });
    const unitTotal = activeUnits.length > 0
      ? activeUnits.reduce((sum, u) => sum + calcUnitFee(u, monthlyFee), 0)
      : monthlyFee;
    const totalAmount = unitTotal * payablePeriods.length;

    const client     = await getMPClient(req.orgId);
    const preference = new Preference(client);

    const appBaseUrl = process.env.APP_BASE_URL;
    const apiBaseUrl = process.env.API_BASE_URL || process.env.PUBLIC_API_BASE_URL || appBaseUrl;

    const periodLabel = payablePeriods.length === 1
      ? org.feePeriodLabel
      : `${payablePeriods.length} períodos`;

    const preferenceData = {
      items: [
        {
          id:          `fee-${payablePeriods[0]}-${payablePeriods.length}p-${owner._id}`,
          title:       `${org.feeLabel} ${periodLabel} — ${org.name}`,
          description: `${owner.name} — ${owner.unit || ''}`.trim(),
          quantity:    1,
          unit_price:  totalAmount,
          currency_id: 'ARS',
        },
      ],
      payer: {
        name:    owner.name.split(' ')[0],
        surname: owner.name.split(' ').slice(1).join(' '),
        email:   owner.email,
      },
      back_urls: {
        success: `${appBaseUrl}/pago/exitoso`,
        failure: `${appBaseUrl}/pago/fallido`,
        pending: `${appBaseUrl}/pago/pendiente`,
      },
      auto_return: 'approved',
      notification_url: `${apiBaseUrl}/api/mercadopago/webhook`,
      // Formato: orgId|ownerId|period1,period2,...|timestamp
      external_reference: `${req.orgId}|${owner._id}|${payablePeriods.join(',')}|${Date.now()}`,
      expires: true,
      expiration_date_to: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const result = await preference.create({ body: preferenceData });

    logger.info(`Preferencia MP creada: ${result.id} — ${owner.name} — ${payablePeriods.length} período(s) [org: ${req.orgId}]`);

    res.json({
      success: true,
      data: {
        preferenceId: result.id,
        initPoint:    result.init_point,
        sandboxUrl:   result.sandbox_init_point,
        periods:      payablePeriods,
        totalAmount,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/mercadopago/webhook — recibir notificaciones ────
exports.webhook = async (req, res) => {
  res.sendStatus(200);

  try {
    const body = parseWebhookBody(req.body);
    if (!body) {
      logger.warn('Webhook MP: body inválido');
      return;
    }

    const { type, data } = body;
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];

    if (type === 'payment' && data?.id) {
      const client = await _getClientForWebhook(data.id);
      if (!client) return;

      const { mpClient, orgId, org } = client;
      const mpPayment = new MPPayment(mpClient);
      const mpData    = await mpPayment.get({ id: data.id });

      logger.info(`Webhook MP — pago ${data.id}: status=${mpData.status}`);

      // Verificar firma del webhook
      if (org?.mpWebhookSecret && xSignature) {
        const ts  = xSignature.split(',').find(p => p.startsWith('ts='))?.split('=')[1];
        const v1  = xSignature.split(',').find(p => p.startsWith('v1='))?.split('=')[1];
        const manifest = `id:${data?.id};request-id:${xRequestId};ts:${ts};`;
        const expected = crypto.createHmac('sha256', org.mpWebhookSecret).update(manifest).digest('hex');
        if (v1 !== expected) {
          logger.warn('Webhook MP: firma inválida');
          return;
        }
      }

      // Buscar todos los pagos asociados a esta preferencia MP
      let paymentList = [];
      if (mpData.preference_id) {
        paymentList = await Payment.find({
          mpPreferenceId: mpData.preference_id,
          status:         { $in: ['pending', 'approved'] },
        }).populate('owner', 'name email unit fcmToken');
      }

      // Fallback: buscar por external_reference (compatibilidad hacia atrás)
      if (!paymentList.length && mpData.external_reference) {
        const ref = parseExternalReference(mpData.external_reference);
        const refOrgId = ref?.orgId;
        const ownerId = ref?.ownerId;
        const months = ref?.periods || [];
        if (months.length > 0) {
          paymentList = await Payment.find({
            organization:  refOrgId,
            owner:         ownerId,
            month:         { $in: months },
            paymentMethod: 'mercadopago',
            status:        { $in: ['pending', 'approved'] },
          }).populate('owner', 'name email unit fcmToken');
        }
      }

      if (!paymentList.length) {
        // Sin registro previo: el pago fue iniciado sin crear registro anticipado.
        // Para approved/pending creamos el registro ahora desde external_reference.
        if (['rejected', 'cancelled'].includes(mpData.status)) {
          logger.info(`Webhook MP: ${mpData.status} sin registro previo � ${mpData.external_reference}`);
          return;
        }

        if (!mpData.external_reference) {
          logger.warn(`Webhook MP: no se encontraron pagos y no hay external_reference para ${data.id}`);
          return;
        }

        paymentList = await createPaymentsFromMPReference(mpData);
        if (!paymentList.length) return;
      }
      // Actualizar todos los pagos
      for (const payment of paymentList) {
        payment.mpPaymentId = String(data.id);
        payment.mpStatus    = mpData.status;
        payment.mpDetail    = mpData.status_detail;

        if (mpData.status === 'approved') {
          payment.status     = 'approved';
          payment.reviewedAt = payment.reviewedAt || new Date();
        } else if (['rejected', 'cancelled'].includes(mpData.status)) {
          payment.status        = 'rejected';
          payment.rejectionNote = `Rechazado por MercadoPago: ${mpData.status_detail}`;
        }
      }

      await Promise.all(paymentList.map(p => p.save()));
      await Promise.all(paymentList.filter(p => p.status === 'approved').map(settleOwnerAccount));

      const firstPayment  = paymentList[0];
      const ownerDoc      = firstPayment.owner;
      const totalAmount   = paymentList.reduce((sum, p) => sum + p.amount, 0);

      if (mpData.status === 'approved') {
        const periodsSummary = paymentList.length === 1
          ? firstPayment.monthFormatted
          : `${paymentList.length} períodos`;

        await generateReceiptsForApprovedMPPayments(paymentList);

        Promise.allSettled([
          emailService.sendPaymentApproved(ownerDoc, firstPayment),
          firebaseService.sendToUser(ownerDoc._id, {
            title: 'Pago aprobado',
            body:  `Recibimos tu pago de ${periodsSummary} por $${totalAmount.toLocaleString('es-AR')}.`,
            data:  { type: 'payment_approved', paymentId: firstPayment._id.toString() },
          }),
        ]);

        logger.info(`Pago MP aprobado: ${paymentList.length} período(s) — ${ownerDoc?.name}`);

      } else if (['rejected', 'cancelled'].includes(mpData.status)) {
        Promise.allSettled([
          emailService.sendPaymentRejected(ownerDoc, firstPayment, firstPayment.rejectionNote),
          firebaseService.sendToUser(ownerDoc._id, {
            title: 'Pago rechazado',
            body:  `Tu pago no pudo procesarse. Intentá nuevamente.`,
            data:  { type: 'payment_rejected', paymentId: firstPayment._id.toString() },
          }),
        ]);
      }
    }
  } catch (err) {
    logger.error(`Error procesando webhook MP: ${err.message}`, err);
  }
};

function parseWebhookBody(body) {
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      return null;
    }
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  return body && typeof body === 'object' ? body : null;
}

/**
 * Resuelve el cliente MP para un webhook dado su MP payment ID.
 */
async function _getClientForWebhook(mpPaymentId) {
  try {
    // Buscar si ya tenemos este pago registrado con su org
    const existing = await Payment.findOne({ mpPaymentId: String(mpPaymentId) });
    if (existing?.organization) {
      const org = await Organization.findById(existing.organization).select('+mpAccessToken +mpWebhookSecret');
      if (org?.mpAccessToken) {
        return {
          mpClient: new MercadoPagoConfig({ accessToken: org.mpAccessToken }),
          orgId: org._id,
          org,
        };
      }
    }

    // Fallback: primera org activa con accessToken configurado
    const org = await Organization.findOne({ isActive: true }).select('+mpAccessToken +mpWebhookSecret');
    if (!org?.mpAccessToken) {
      logger.warn(`Webhook MP: no se encontró organización con MP configurado para pago ${mpPaymentId}`);
      return null;
    }
    return {
      mpClient: new MercadoPagoConfig({ accessToken: org.mpAccessToken }),
      orgId: org._id,
      org,
    };
  } catch (err) {
    logger.error(`_getClientForWebhook error: ${err.message}`);
    return null;
  }
}

// ── GET /api/mercadopago/payment/:mpPaymentId — consultar ─────
exports.getPaymentStatus = async (req, res, next) => {
  try {
    const client    = await getMPClient(req.orgId);
    const mpPayment = new MPPayment(client);
    const data      = await mpPayment.get({ id: req.params.mpPaymentId });
    const payments  = await ensurePaymentsFromMPData(data);

    res.json({
      success: true,
      data: {
        id:         data.id,
        status:     data.status,
        detail:     data.status_detail,
        amount:     data.transaction_amount,
        method:     data.payment_method_id,
        approvedAt: data.date_approved,
        payments:   payments.map(p => ({
          id:     p._id,
          month:  p.month,
          status: p.status,
          amount: p.amount,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};
