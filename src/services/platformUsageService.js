const PlatformUsageEvent = require('../models/PlatformUsageEvent');
const logger = require('../config/logger');
const { normalizeRole } = require('../utils/roles');

const SENSITIVE_KEYS = new Set([
  'password',
  'newPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'fcmToken',
  'authorization',
  'mpAccessToken',
  'mpPublicKey',
  'mpWebhookSecret',
  'webhookSecret',
  'secret',
  'credential',
  'credentials',
  'rejectionNote',
  'adminNote',
  'ownerNote',
  'body',
  'description',
]);

function sanitizeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};

  return Object.entries(metadata).reduce((safe, [key, value]) => {
    if (SENSITIVE_KEYS.has(key)) return safe;
    if (value === undefined || typeof value === 'function') return safe;
    if (value && typeof value === 'object') {
      if (value instanceof Date) {
        safe[key] = value.toISOString();
      } else {
        safe[key] = sanitizeMetadata(value);
      }
      return safe;
    }
    safe[key] = value;
    return safe;
  }, {});
}

async function trackUsageEvent({ organizationId = null, userId = null, role, eventType, module, metadata = {} }) {
  try {
    if (!eventType || !module) return null;

    return await PlatformUsageEvent.create({
      organizationId: organizationId || null,
      userId: userId || null,
      role: normalizeRole(role || 'owner'),
      eventType,
      module,
      metadata: sanitizeMetadata(metadata),
    });
  } catch (err) {
    logger.error('[platformUsage] No se pudo registrar evento de uso', {
      eventType,
      module,
      error: err.message,
    });
    return null;
  }
}

module.exports = {
  sanitizeMetadata,
  trackUsageEvent,
};
