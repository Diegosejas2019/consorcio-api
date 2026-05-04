const { MercadoPagoConfig, Preference, Payment: MPPayment } = require('mercadopago');
const crypto       = require('crypto');
const Payment            = require('../models/Payment');
const User               = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Unit               = require('../models/Unit');
const Organization = require('../models/Organization');
const { calcUnitFee } = require('./unitController');
const emailService   = require('../services/emailService');
const firebaseService = require('../services/firebaseService');
const logger  = require('../config/logger');

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

    const baseUrl = process.env.APP_BASE_URL;

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
        success: `${baseUrl}/pago/exitoso`,
        failure: `${baseUrl}/pago/fallido`,
        pending: `${baseUrl}/pago/pendiente`,
      },
      auto_return: 'approved',
      notification_url: `${baseUrl}/api/mercadopago/webhook`,
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
          status:         'pending',
        }).populate('owner', 'name email unit fcmToken');
      }

      // Fallback: buscar por external_reference (compatibilidad hacia atrás)
      if (!paymentList.length && mpData.external_reference) {
        const parts      = mpData.external_reference.split('|');
        const [refOrgId, ownerId, monthCodes] = parts;
        const months     = monthCodes?.split(',').filter(Boolean) || [];
        if (months.length > 0) {
          paymentList = await Payment.find({
            organization:  refOrgId,
            owner:         ownerId,
            month:         { $in: months },
            paymentMethod: 'mercadopago',
            status:        'pending',
          }).populate('owner', 'name email unit fcmToken');
        }
      }

      if (!paymentList.length) {
        // Sin registro previo: el pago fue iniciado sin crear registro anticipado.
        // Para approved/pending creamos el registro ahora desde external_reference.
        if (['rejected', 'cancelled'].includes(mpData.status)) {
          logger.info(`Webhook MP: ${mpData.status} sin registro previo — ${mpData.external_reference}`);
          return;
        }

        if (!mpData.external_reference) {
          logger.warn(`Webhook MP: no se encontraron pagos y no hay external_reference para ${data.id}`);
          return;
        }

        const parts = mpData.external_reference.split('|');
        const [refOrgId, refOwnerId, monthCodes] = parts;
        const refMonths = monthCodes?.split(',').filter(Boolean) || [];

        if (!refOwnerId || refMonths.length === 0) {
          logger.warn(`Webhook MP: external_reference incompleto: ${mpData.external_reference}`);
          return;
        }

        // Excluir períodos que ya tienen pago activo (idempotencia + respeto al índice único)
        const existingActive = await Payment.find({
          organization: refOrgId,
          owner:        refOwnerId,
          month:        { $in: refMonths },
          status:       { $in: ['pending', 'approved'] },
        }).select('month');
        const activeSet  = new Set(existingActive.map(p => p.month));
        const newMonths  = refMonths.filter(m => !activeSet.has(m));

        if (newMonths.length === 0) {
          logger.info(`Webhook MP: todos los períodos ya tienen pago activo para ${refOwnerId}`);
          return;
        }

        const [refOrg, refMembership] = await Promise.all([
          Organization.findById(refOrgId),
          OrganizationMember.findOne({ user: refOwnerId, organization: refOrgId, role: 'owner' }).select('_id'),
        ]);
        const monthlyFee = refOrg?.monthlyFee || 0;

        // Calcular monto desde unidades activas del propietario
        const refUnits = await Unit.find({ owner: refOwnerId, active: true, organization: refOrgId }).sort({ name: 1 });
        const unitAmount = refUnits.length > 0
          ? refUnits.reduce((sum, u) => sum + calcUnitFee(u, monthlyFee), 0)
          : monthlyFee;
        const unitsSnapshot   = refUnits.map(u => u._id);
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
            mpPreferenceId: mpData.preference_id,
            units:          unitsSnapshot,
            breakdown:      breakdownSnapshot,
          }))
        );

        paymentList = await Payment.find({ _id: { $in: created.map(p => p._id) } })
          .populate('owner', 'name email unit fcmToken');

        logger.info(`Webhook MP: creados ${created.length} registro(s) desde external_reference — ${refOwnerId}`);
      }

      // Actualizar todos los pagos
      for (const payment of paymentList) {
        payment.mpPaymentId = String(data.id);
        payment.mpStatus    = mpData.status;
        payment.mpDetail    = mpData.status_detail;

        if (mpData.status === 'approved') {
          payment.status = 'pending';
        } else if (['rejected', 'cancelled'].includes(mpData.status)) {
          payment.status        = 'rejected';
          payment.rejectionNote = `Rechazado por MercadoPago: ${mpData.status_detail}`;
        }
      }

      await Promise.all(paymentList.map(p => p.save()));

      const firstPayment  = paymentList[0];
      const ownerDoc      = firstPayment.owner;
      const totalAmount   = paymentList.reduce((sum, p) => sum + p.amount, 0);

      if (mpData.status === 'approved') {
        const periodsSummary = paymentList.length === 1
          ? firstPayment.monthFormatted
          : `${paymentList.length} períodos`;

        Promise.allSettled([
          firebaseService.sendToUser(ownerDoc._id, {
            title: 'Pago recibido',
            body:  `Recibimos tu pago de ${periodsSummary} por $${totalAmount.toLocaleString('es-AR')}. Quedó pendiente de aprobación.`,
            data:  { type: 'payment_pending_approval', paymentId: firstPayment._id.toString() },
          }),
        ]);

        logger.info(`Pago MP recibido pendiente de aprobación: ${paymentList.length} período(s) — ${ownerDoc?.name}`);

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

    res.json({
      success: true,
      data: {
        id:         data.id,
        status:     data.status,
        detail:     data.status_detail,
        amount:     data.transaction_amount,
        method:     data.payment_method_id,
        approvedAt: data.date_approved,
      },
    });
  } catch (err) {
    next(err);
  }
};
