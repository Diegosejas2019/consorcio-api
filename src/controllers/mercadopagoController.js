const { MercadoPagoConfig, Preference, Payment: MPPayment } = require('mercadopago');
const crypto  = require('crypto');
const Payment = require('../models/Payment');
const User    = require('../models/User');
const Config  = require('../models/Config');
const emailService   = require('../services/emailService');
const firebaseService = require('../services/firebaseService');
const logger  = require('../config/logger');

// ── Helper: instancia MP con credenciales del consorcio ───────
async function getMPClient() {
  const config = await Config.findOne({ _singleton: 'global' }).select('+mpAccessToken');
  if (!config?.mpAccessToken) throw new Error('MercadoPago no configurado. Contactá al administrador.');
  return new MercadoPagoConfig({ accessToken: config.mpAccessToken });
}

// ── POST /api/mercadopago/preference — crear preferencia ──────
exports.createPreference = async (req, res, next) => {
  try {
    const config = await Config.getConfig();
    const owner  = req.user;

    const client     = await getMPClient();
    const preference = new Preference(client);

    const baseUrl = process.env.APP_BASE_URL;

    const preferenceData = {
      items: [
        {
          id:          `expensa-${config.expenseMonthCode}-${owner._id}`,
          title:       `Expensa ${config.expenseMonth} — ${config.consortiumName}`,
          description: `${owner.name} — ${owner.unit}`,
          quantity:    1,
          unit_price:  config.expenseAmount,
          currency_id: 'ARS',
        },
      ],
      payer: {
        name:  owner.name.split(' ')[0],
        surname: owner.name.split(' ').slice(1).join(' '),
        email: owner.email,
      },
      back_urls: {
        success: `${baseUrl}/pago/exitoso`,
        failure: `${baseUrl}/pago/fallido`,
        pending: `${baseUrl}/pago/pendiente`,
      },
      auto_return: 'approved',
      notification_url: `${baseUrl}/api/mercadopago/webhook`,
      external_reference: `${owner._id}|${config.expenseMonthCode}|${Date.now()}`,
      expires: true,
      expiration_date_to: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 días
    };

    const result = await preference.create({ body: preferenceData });

    // Guardar preference_id en un pago pendiente
    const payment = await Payment.create({
      owner:         owner._id,
      month:         config.expenseMonthCode,
      amount:        config.expenseAmount,
      status:        'pending',
      paymentMethod: 'mercadopago',
      mpPreferenceId: result.id,
    });

    logger.info(`Preferencia MP creada: ${result.id} — ${owner.name}`);

    res.json({
      success: true,
      data: {
        preferenceId: result.id,
        initPoint:    result.init_point,      // Redirect URL para checkout
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
  // Responder 200 inmediatamente a MP (evitar reintentos)
  res.sendStatus(200);

  try {
    const { type, data, action } = req.body;
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];

    // ── Verificar firma del webhook ─────────────────────────
    const config = await Config.findOne({ _singleton: 'global' }).select('+mpWebhookSecret');
    if (config?.mpWebhookSecret && xSignature) {
      const ts  = xSignature.split(',').find(p => p.startsWith('ts='))?.split('=')[1];
      const v1  = xSignature.split(',').find(p => p.startsWith('v1='))?.split('=')[1];
      const manifest = `id:${data?.id};request-id:${xRequestId};ts:${ts};`;
      const expected = crypto.createHmac('sha256', config.mpWebhookSecret).update(manifest).digest('hex');
      if (v1 !== expected) {
        logger.warn('Webhook MP: firma inválida');
        return;
      }
    }

    // ── Procesar evento de pago ─────────────────────────────
    if (type === 'payment' && data?.id) {
      const client    = await getMPClient();
      const mpPayment = new MPPayment(client);
      const mpData    = await mpPayment.get({ id: data.id });

      logger.info(`Webhook MP — pago ${data.id}: status=${mpData.status}`);

      const externalRef = mpData.external_reference;
      if (!externalRef) return;

      const [ownerId, monthCode] = externalRef.split('|');

      const payment = await Payment.findOne({
        owner: ownerId,
        month: monthCode,
        paymentMethod: 'mercadopago',
        status: { $in: ['pending'] },
      }).populate('owner', 'name email unit fcmToken');

      if (!payment) {
        logger.warn(`Webhook MP: no se encontró pago para ${externalRef}`);
        return;
      }

      // Actualizar datos de MP
      payment.mpPaymentId = String(data.id);
      payment.mpStatus    = mpData.status;
      payment.mpDetail    = mpData.status_detail;

      if (mpData.status === 'approved') {
        payment.status    = 'approved';
        payment.reviewedAt = new Date();

        await payment.save();

        // Actualizar estado del propietario
        await User.findByIdAndUpdate(ownerId, { isDebtor: false, balance: 0 });

        // Notificaciones
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
        // pending, in_process, etc.
        await payment.save();
      }
    }
  } catch (err) {
    logger.error(`Error procesando webhook MP: ${err.message}`, err);
  }
};

// ── GET /api/mercadopago/payment/:mpPaymentId — consultar ─────
exports.getPaymentStatus = async (req, res, next) => {
  try {
    const client    = await getMPClient();
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
