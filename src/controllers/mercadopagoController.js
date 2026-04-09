const { MercadoPagoConfig, Preference, Payment: MPPayment } = require('mercadopago');
const crypto       = require('crypto');
const Payment      = require('../models/Payment');
const User         = require('../models/User');
const Organization = require('../models/Organization');
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

    const client     = await getMPClient(req.orgId);
    const preference = new Preference(client);

    const baseUrl = process.env.APP_BASE_URL;

    const preferenceData = {
      items: [
        {
          id:          `fee-${org.feePeriodCode}-${owner._id}`,
          title:       `${org.feeLabel} ${org.feePeriodLabel} — ${org.name}`,
          description: `${owner.name} — ${owner.unit || ''}`.trim(),
          quantity:    1,
          unit_price:  org.feeAmount,
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
      // Incluir orgId para poder resolverlo en el webhook (sin auth)
      external_reference: `${req.orgId}|${owner._id}|${org.feePeriodCode}|${Date.now()}`,
      expires: true,
      expiration_date_to: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const result = await preference.create({ body: preferenceData });

    const payment = await Payment.create({
      organization:   req.orgId,
      owner:          owner._id,
      month:          org.feePeriodCode,
      amount:         org.feeAmount,
      status:         'pending',
      paymentMethod:  'mercadopago',
      mpPreferenceId: result.id,
    });

    logger.info(`Preferencia MP creada: ${result.id} — ${owner.name} [org: ${req.orgId}]`);

    res.json({
      success: true,
      data: {
        preferenceId: result.id,
        initPoint:    result.init_point,
        sandboxUrl:   result.sandbox_init_point,
        paymentId:    payment._id,
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
    const { type, data } = req.body;
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];

    if (type === 'payment' && data?.id) {
      // Necesitamos saber de qué org es este pago — primero buscar sin org filter
      // usando mpPaymentId o external_reference (disponible tras llamar a MP)
      const client    = await _getClientForWebhook(data.id);
      if (!client) return;

      const { mpClient, orgId, org } = client;
      const mpPayment = new MPPayment(mpClient);
      const mpData    = await mpPayment.get({ id: data.id });

      logger.info(`Webhook MP — pago ${data.id}: status=${mpData.status}`);

      // Verificar firma del webhook con el secret de la org
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

      const externalRef = mpData.external_reference;
      if (!externalRef) return;

      // Formato: orgId|ownerId|monthCode|timestamp
      const parts = externalRef.split('|');
      const [refOrgId, ownerId, monthCode] = parts;

      const payment = await Payment.findOne({
        organization:  refOrgId,
        owner:         ownerId,
        month:         monthCode,
        paymentMethod: 'mercadopago',
        status:        { $in: ['pending'] },
      }).populate('owner', 'name email unit fcmToken');

      if (!payment) {
        logger.warn(`Webhook MP: no se encontró pago para ${externalRef}`);
        return;
      }

      payment.mpPaymentId = String(data.id);
      payment.mpStatus    = mpData.status;
      payment.mpDetail    = mpData.status_detail;

      if (mpData.status === 'approved') {
        payment.status    = 'approved';
        payment.reviewedAt = new Date();
        await payment.save();

        await User.findByIdAndUpdate(ownerId, { isDebtor: false, balance: 0 });

        Promise.allSettled([
          emailService.sendPaymentApproved(payment.owner, payment),
          firebaseService.sendToUser(payment.owner._id, {
            title: '¡Pago recibido! ✓',
            body:  `Tu pago de ${payment.monthFormatted} por $${payment.amount.toLocaleString('es-AR')} fue confirmado.`,
            data:  { type: 'payment_approved', paymentId: payment._id.toString() },
          }),
        ]);

        logger.info(`Pago MP aprobado automáticamente: ${payment._id} — ${payment.owner?.name}`);

      } else if (['rejected', 'cancelled'].includes(mpData.status)) {
        payment.status        = 'rejected';
        payment.rejectionNote = `Rechazado por MercadoPago: ${mpData.status_detail}`;
        await payment.save();

        Promise.allSettled([
          emailService.sendPaymentRejected(payment.owner, payment, payment.rejectionNote),
          firebaseService.sendToUser(payment.owner._id, {
            title: 'Pago rechazado',
            body:  `Tu pago de ${payment.monthFormatted} no pudo procesarse. Intentá nuevamente.`,
            data:  { type: 'payment_rejected', paymentId: payment._id.toString() },
          }),
        ]);
      } else {
        await payment.save();
      }
    }
  } catch (err) {
    logger.error(`Error procesando webhook MP: ${err.message}`, err);
  }
};

/**
 * Resuelve el cliente MP para un webhook dado su MP payment ID.
 * Estrategia: buscar en todos los pagos pending de MP este mpPaymentId,
 * o usar el orgId embebido en external_reference vía una llamada preliminar.
 * Para simplificar, intentamos con todos los orgs activos que tengan accessToken.
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

    // Fallback: buscar la primera org con accessToken configurado
    // (solo funciona en entornos con una única org activa o bien definida)
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
