require('dotenv').config();
const app              = require('./src/app');
const connectDB        = require('./src/config/db');
const logger           = require('./src/config/logger');
const { initScheduler } = require('./src/services/schedulerService');

const PORT = process.env.PORT || 3000;

// ── Conectar DB y arrancar servidor ──────────────────────────
const start = async () => {
  try {
    await connectDB();
    initScheduler();

    const server = app.listen(PORT, () => {
      logger.info(`GestionAr API corriendo en http://localhost:${PORT} [${process.env.NODE_ENV}]`);
    });

    // ── Graceful shutdown ────────────────────────────────────
    const shutdown = (signal) => {
      logger.info(`${signal} recibido. Cerrando servidor...`);
      server.close(async () => {
        const mongoose = require('mongoose');
        await mongoose.connection.close();
        logger.info('MongoDB cerrado. Servidor apagado correctamente.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    // Errores no capturados
    process.on('unhandledRejection', (err) => {
      logger.error(`UnhandledRejection: ${err.message}`, err);
      server.close(() => process.exit(1));
    });
    process.on('uncaughtException', (err) => {
      logger.error(`UncaughtException: ${err.message}`, err);
      process.exit(1);
    });

  } catch (err) {
    logger.error(`Error al iniciar: ${err.message}`);
    process.exit(1);
  }
};

start();
