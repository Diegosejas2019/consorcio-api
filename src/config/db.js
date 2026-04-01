const mongoose = require('mongoose');
const logger   = require('./logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      // Las opciones useNewUrlParser y useUnifiedTopology ya no son necesarias en Mongoose 7+
    });

    logger.info(`MongoDB conectado: ${conn.connection.host} — DB: ${conn.connection.name}`);

    // Eventos de conexión
    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB error de conexión: ${err.message}`);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB desconectado. Intentando reconectar...');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconectado exitosamente.');
    });

  } catch (err) {
    logger.error(`Error al conectar MongoDB: ${err.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
