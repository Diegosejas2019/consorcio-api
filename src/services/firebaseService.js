const admin  = require('firebase-admin');
const User   = require('../models/User');
const logger = require('../config/logger');

// ── Inicializar Firebase Admin SDK ────────────────────────────
let firebaseInitialized = false;

const initFirebase = () => {
  if (firebaseInitialized || admin.apps.length > 0) return;

  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !privateKey) {
    logger.warn('[Firebase] Credenciales no configuradas (FIREBASE_PROJECT_ID o FIREBASE_PRIVATE_KEY faltantes). Push notifications deshabilitadas.');
    return;
  }
  if (!clientEmail) {
    logger.warn('[Firebase] FIREBASE_CLIENT_EMAIL no configurado.');
  }

  logger.info(`[Firebase] Inicializando con projectId: ${projectId}, clientEmail: ${clientEmail}`);

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    });
    firebaseInitialized = true;
    logger.info('[Firebase] Admin SDK inicializado correctamente.');
  } catch (err) {
    logger.error(`[Firebase] Error al inicializar: ${err.message}`, { stack: err.stack });
  }
};

initFirebase();

// ── Enviar notificación a un usuario específico ───────────────
exports.sendToUser = async (userId, { title, body, data = {} }) => {
  if (!firebaseInitialized) return null;

  try {
    const user = await User.findById(userId).select('+fcmToken');
    if (!user?.fcmToken) {
      logger.debug(`Push: usuario ${userId} sin FCM token.`);
      return null;
    }

    const message = {
      token: user.fcmToken,
      data: { ...data, title, body, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
      android: { priority: 'high' },
      apns:    { payload: { aps: { contentAvailable: true } } },
      webpush: { headers: { Urgency: 'high' } },
    };

    const response = await admin.messaging().send(message);
    logger.debug(`Push enviado a ${user.email}: ${response}`);
    return response;
  } catch (err) {
    // Token inválido → limpiar
    if (err.code === 'messaging/registration-token-not-registered') {
      await User.findByIdAndUpdate(userId, { fcmToken: null });
      logger.warn(`Push: FCM token inválido removido para usuario ${userId}`);
    } else {
      logger.error(`Error enviando push a usuario ${userId}: ${err.message}`);
    }
    return null;
  }
};

// ── Enviar notificación a múltiples tokens ────────────────────
exports.sendMulticast = async (tokens, { title, body, data = {} }) => {
  if (!firebaseInitialized) {
    logger.warn('[Firebase] sendMulticast llamado pero Firebase no está inicializado.');
    return null;
  }
  if (tokens.length === 0) {
    logger.warn('[Firebase] sendMulticast llamado con lista de tokens vacía.');
    return null;
  }

  // Firebase permite hasta 500 tokens por llamada
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) {
    chunks.push(tokens.slice(i, i + 500));
  }

  logger.info(`[Firebase] sendMulticast: ${tokens.length} token(s), ${chunks.length} chunk(s)`);

  const results = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const message = {
      tokens: chunk,
      data: { ...data, title, body, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
      android: { priority: 'high' },
      apns:    { payload: { aps: { contentAvailable: true } } },
      webpush: { headers: { Urgency: 'high' } },
    };

    logger.debug(`[Firebase] Chunk ${ci + 1}/${chunks.length}: enviando a ${chunk.length} tokens`);
    const response = await admin.messaging().sendEachForMulticast(message);
    logger.info(`[Firebase] Chunk ${ci + 1}: ${response.successCount} exitosos, ${response.failureCount} fallidos`);

    // Log de errores individuales
    response.responses.forEach((r, idx) => {
      if (!r.success) {
        logger.warn(`[Firebase] Token[${idx}] falló — code: ${r.error?.code}, message: ${r.error?.message}`);
      }
    });

    // Limpiar tokens inválidos
    const invalidTokens = chunk.filter((_, idx) =>
      !response.responses[idx].success &&
      response.responses[idx].error?.code === 'messaging/registration-token-not-registered'
    );
    if (invalidTokens.length > 0) {
      await Promise.all(
        invalidTokens.map(token => User.findOneAndUpdate({ fcmToken: token }, { fcmToken: null }))
      );
      logger.info(`[Firebase] ${invalidTokens.length} token(s) inválido(s) removidos`);
    }

    results.push(response);
  }
  return results;
};

// ── Enviar recordatorio mensual a todos los deudores ──────────
exports.sendMonthlyReminders = async (orgId, expenseMonth, amount) => {
  if (!firebaseInitialized) return;

  const debtors = await User.find({ organization: orgId, role: 'owner', isActive: true, isDebtor: true }).select('+fcmToken');
  const tokens  = debtors.map(o => o.fcmToken).filter(Boolean);

  if (tokens.length === 0) return;

  return exports.sendMulticast(tokens, {
    title: `Recordatorio: Expensas ${expenseMonth}`,
    body:  `Tu expensa de $${amount.toLocaleString('es-AR')} está pendiente de pago.`,
    data:  { type: 'monthly_reminder' },
  });
};
