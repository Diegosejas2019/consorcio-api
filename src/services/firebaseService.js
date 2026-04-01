const admin  = require('firebase-admin');
const User   = require('../models/User');
const logger = require('../config/logger');

// ── Inicializar Firebase Admin SDK ────────────────────────────
let firebaseInitialized = false;

const initFirebase = () => {
  if (firebaseInitialized || admin.apps.length > 0) return;

  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY) {
    logger.warn('Firebase: credenciales no configuradas. Push notifications deshabilitadas.');
    return;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    firebaseInitialized = true;
    logger.info('Firebase Admin SDK inicializado correctamente.');
  } catch (err) {
    logger.error(`Error inicializando Firebase: ${err.message}`);
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
      notification: { title, body },
      data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
      android: { priority: 'high', notification: { sound: 'default', channelId: 'consorcio' } },
      apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
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
  if (!firebaseInitialized || tokens.length === 0) return null;

  // Firebase permite hasta 500 tokens por llamada
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) {
    chunks.push(tokens.slice(i, i + 500));
  }

  const results = [];
  for (const chunk of chunks) {
    const message = {
      tokens: chunk,
      notification: { title, body },
      data,
      android: { priority: 'high', notification: { sound: 'default', channelId: 'consorcio' } },
      apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    logger.info(`Push multicast: ${response.successCount} exitosos, ${response.failureCount} fallidos`);

    // Limpiar tokens inválidos
    response.responses.forEach(async (r, idx) => {
      if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
        await User.findOneAndUpdate({ fcmToken: chunk[idx] }, { fcmToken: null });
      }
    });

    results.push(response);
  }
  return results;
};

// ── Enviar recordatorio mensual a todos los deudores ──────────
exports.sendMonthlyReminders = async (expenseMonth, amount) => {
  if (!firebaseInitialized) return;

  const debtors = await User.find({ role: 'owner', isActive: true, isDebtor: true }).select('+fcmToken');
  const tokens  = debtors.map(o => o.fcmToken).filter(Boolean);

  if (tokens.length === 0) return;

  return exports.sendMulticast(tokens, {
    title: `Recordatorio: Expensas ${expenseMonth}`,
    body:  `Tu expensa de $${amount.toLocaleString('es-AR')} está pendiente de pago.`,
    data:  { type: 'monthly_reminder' },
  });
};
