const PRODUCTION_DB = 'consorcio';
const QA_DB = 'gestionar_qa';

function getRuntimeEnvironment() {
  return String(process.env.NODE_ENV || 'development').trim().toLowerCase();
}

function getMongoDatabaseName(uri) {
  if (!uri) return '';

  try {
    const parsed = new URL(uri);
    return decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  } catch {
    const match = String(uri).match(/\/([^/?#]+)(?:[?#]|$)/);
    return match ? decodeURIComponent(match[1]) : '';
  }
}

function assertMongoEnvironment({ uri = process.env.MONGODB_URI, variableName = 'MONGODB_URI', operation = 'runtime' } = {}) {
  const env = getRuntimeEnvironment();
  const dbName = getMongoDatabaseName(uri);

  if (!uri) {
    throw new Error(`Falta ${variableName}. No se puede iniciar sin configurar MongoDB.`);
  }

  if (!dbName) {
    throw new Error(`${variableName} debe incluir el nombre de la base de datos.`);
  }

  if (env === 'production' && dbName !== PRODUCTION_DB) {
    throw new Error(`Configuracion insegura: NODE_ENV=production debe usar la base ${PRODUCTION_DB}.`);
  }

  if (['qa', 'staging'].includes(env) && dbName !== QA_DB) {
    throw new Error(`Configuracion insegura: NODE_ENV=${env} debe usar la base ${QA_DB}.`);
  }

  if (operation === 'write-script' && dbName === PRODUCTION_DB && process.env.ALLOW_PRODUCTION_DB_WRITE !== 'true') {
    throw new Error(
      `Operacion bloqueada: ${variableName} apunta a ${PRODUCTION_DB}. ` +
      'Defini ALLOW_PRODUCTION_DB_WRITE=true solo con confirmacion explicita.'
    );
  }

  return { env, dbName };
}

module.exports = {
  PRODUCTION_DB,
  QA_DB,
  getMongoDatabaseName,
  getRuntimeEnvironment,
  assertMongoEnvironment,
};
