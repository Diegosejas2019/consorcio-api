const logger = require('../config/logger');

// ── Manejador de errores global ───────────────────────────────
const errorHandler = (err, req, res, next) => {
  let error = { ...err, message: err.message };

  // Log del error
  logger.error(`${err.name}: ${err.message}`, { stack: err.stack, url: req.originalUrl });

  // ── Mongoose: ID inválido ─────────────────────────────────
  if (err.name === 'CastError') {
    error = { message: `ID inválido: ${err.value}`, statusCode: 400 };
  }

  // ── Mongoose: campo duplicado (código 11000) ──────────────
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const fieldMap = {
      email: 'El email ya está registrado.',
      'owner_month': 'Ya existe un comprobante activo para ese período.',
    };
    error = {
      message: fieldMap[field] || `El campo '${field}' ya existe. Por favor usá otro valor.`,
      statusCode: 400,
    };
  }

  // ── Mongoose: validación ──────────────────────────────────
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    error = { message: messages.join('. '), statusCode: 400 };
  }

  // ── Multer: archivo demasiado grande ──────────────────────
  if (err.code === 'LIMIT_FILE_SIZE') {
    error = { message: 'El archivo supera el límite de 10 MB.', statusCode: 400 };
  }

  // ── Multer: tipo de archivo ───────────────────────────────
  if (err.message?.includes('Tipo de archivo no permitido')) {
    error = { message: err.message, statusCode: 400 };
  }

  const statusCode = error.statusCode || err.statusCode || 500;
  const message    = error.message || 'Error interno del servidor.';

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

// ── 404 Not Found ─────────────────────────────────────────────
const notFound = (req, res, next) => {
  const err = new Error(`Ruta no encontrada: ${req.originalUrl}`);
  err.statusCode = 404;
  next(err);
};

module.exports = { errorHandler, notFound };
