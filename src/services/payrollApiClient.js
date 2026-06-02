const logger = require('../config/logger');

const PAYROLL_API_URL = process.env.PAYROLL_API_URL;
const PAYROLL_API_KEY = process.env.PAYROLL_API_KEY;

const MAX_RETRIES = 2;
const TIMEOUT_MS  = 15000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetry(url, options) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, TIMEOUT_MS);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`payroll-api-argentina respondió ${res.status}: ${body.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        // Backoff exponencial: 500ms, 1000ms
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

// Calcula liquidación via API externa
async function calculateExternal({ period, liquidationType, employer, employee, settings, news }) {
  if (!PAYROLL_API_URL || !PAYROLL_API_KEY) {
    throw new Error('La API externa de liquidación no está configurada (PAYROLL_API_URL, PAYROLL_API_KEY).');
  }

  const payload = { country: 'AR', period, liquidationType, employer, employee, settings, news };

  logger.info(`payrollApiClient: calculate ${liquidationType} ${period} [employee: ${employee.externalEmployeeId}]`);

  const result = await callWithRetry(`${PAYROLL_API_URL}/api/payroll/calculate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': PAYROLL_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  return result;
}

// Verifica que la API externa está disponible
async function healthCheck() {
  if (!PAYROLL_API_URL) return false;
  try {
    const res = await fetchWithTimeout(`${PAYROLL_API_URL}/api/payroll/health`, {
      method: 'GET',
      headers: { 'x-api-key': PAYROLL_API_KEY },
    }, 5000);
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { calculateExternal, healthCheck };
