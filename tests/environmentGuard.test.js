const {
  getMongoDatabaseName,
  assertMongoEnvironment,
} = require('../src/config/environmentGuard');

describe('environmentGuard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('extrae el nombre de base desde URI local y Atlas', () => {
    expect(getMongoDatabaseName('mongodb://localhost:27017/gestionar_qa')).toBe('gestionar_qa');
    expect(getMongoDatabaseName('mongodb+srv://user:pass@cluster.mongodb.net/consorcio?retryWrites=true')).toBe('consorcio');
  });

  test('bloquea production si no usa consorcio', () => {
    process.env.NODE_ENV = 'production';

    expect(() => assertMongoEnvironment({
      uri: 'mongodb+srv://user:pass@cluster.mongodb.net/gestionar_qa',
    })).toThrow('NODE_ENV=production debe usar la base consorcio');
  });

  test('bloquea qa si apunta a consorcio', () => {
    process.env.NODE_ENV = 'qa';

    expect(() => assertMongoEnvironment({
      uri: 'mongodb+srv://user:pass@cluster.mongodb.net/consorcio',
    })).toThrow('NODE_ENV=qa debe usar la base gestionar_qa');
  });

  test('bloquea scripts de escritura contra produccion sin confirmacion explicita', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_PRODUCTION_DB_WRITE;

    expect(() => assertMongoEnvironment({
      uri: 'mongodb+srv://user:pass@cluster.mongodb.net/consorcio',
      operation: 'write-script',
    })).toThrow('Operacion bloqueada');
  });
});
