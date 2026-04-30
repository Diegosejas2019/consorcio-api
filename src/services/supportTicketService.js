const SENSITIVE_KEYS = [
  'password',
  'pass',
  'token',
  'jwt',
  'authorization',
  'auth',
  'secret',
  'card',
  'creditcard',
  'credit_card',
  'cvv',
  'cvc',
  'pan',
  'mpaccesstoken',
  'mp_access_token',
];

const MAX_METADATA_KEYS = 30;
const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 3;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive));
}

function sanitizeValue(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[metadata omitida por profundidad]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') return sanitizeMetadata(value, depth + 1);
  return String(value).slice(0, MAX_STRING_LENGTH);
}

function sanitizeMetadata(metadata, depth = 0) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;

  const sanitized = {};
  Object.entries(metadata).slice(0, MAX_METADATA_KEYS).forEach(([key, value]) => {
    if (!key || isSensitiveKey(key)) return;
    sanitized[String(key).slice(0, 80)] = sanitizeValue(value, depth);
  });

  return Object.keys(sanitized).length ? sanitized : undefined;
}

function sanitizeContext(context = {}) {
  if (!context || typeof context !== 'object') return {};

  const sanitized = {};
  if (typeof context.route === 'string') sanitized.route = context.route.trim().slice(0, 500);
  if (typeof context.userAgent === 'string') sanitized.userAgent = context.userAgent.trim().slice(0, 500);
  if (typeof context.action === 'string') sanitized.action = context.action.trim().slice(0, 150);

  const metadata = sanitizeMetadata(context.metadata);
  if (metadata) sanitized.metadata = metadata;

  return sanitized;
}

function buildTicketFilters(query, organizationId = null) {
  const filter = { isActive: { $ne: false } };
  if (organizationId) filter.organizationId = organizationId;
  if (query.organizationId) filter.organizationId = query.organizationId;

  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.priority) filter.priority = query.priority;

  if (query.search) {
    const search = String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { adminResponse: { $regex: search, $options: 'i' } },
      ];
    }
  }

  return filter;
}

module.exports = {
  sanitizeContext,
  sanitizeMetadata,
  buildTicketFilters,
};
