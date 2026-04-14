const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const logger     = require('./config/logger');

const app = express();

// ── Trust proxy (Railway / reverse proxy) ─────────────────────
app.set('trust proxy', 1);

// ── Seguridad: Helmet ─────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Necesario para servir imágenes de Cloudinary
}));

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Permitir requests sin origin (Postman, mobile apps) y orígenes en lista blanca
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
      return cb(null, true);
    }
    cb(new Error(`CORS bloqueado: origen no permitido (${origin})`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Body parsers ──────────────────────────────────────────────
// El webhook de MercadoPago necesita el body en raw para verificar la firma
app.use('/api/mercadopago/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ── Logging HTTP ──────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev', {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip: (req) => req.path === '/health',
  }));
}

// ── Rate Limiting ─────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200,
  message: { success: false, message: 'Demasiadas solicitudes. Intentá de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // máx 10 intentos de login por IP cada 15 min
  message: { success: false, message: 'Demasiados intentos de autenticación. Esperá 15 minutos.' },
  skipSuccessfulRequests: true,
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5, // máx 5 solicitudes de reset por IP por hora
  message: { success: false, message: 'Demasiadas solicitudes de restablecimiento. Intentá de nuevo en 1 hora.' },
  skipSuccessfulRequests: false,
});

app.use('/api', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/forgot-password', forgotPasswordLimiter);

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env:     process.env.NODE_ENV,
    uptime:  Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── Rutas principales ─────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/organizations', require('./routes/organizations'));
app.use('/api/owners',        require('./routes/owners'));
app.use('/api/payments',      require('./routes/payments'));
app.use('/api/notices',       require('./routes/notices'));
app.use('/api/claims',        require('./routes/claims'));
app.use('/api/config',        require('./routes/config'));
app.use('/api/mercadopago',   require('./routes/mercadopago'));

// ── Raíz API ──────────────────────────────────────────────────
app.get('/api', (req, res) => {
  res.json({
    name:    'GestionAr API',
    version: '1.0.0',
    status:  'online',
    docs:    '/api/docs',
    endpoints: {
      auth:          '/api/auth',
      organizations: '/api/organizations',
      owners:        '/api/owners',
      payments:      '/api/payments',
      notices:       '/api/notices',
      claims:        '/api/claims',
      config:        '/api/config',
      mercadopago:   '/api/mercadopago',
    },
  });
});

// ── 404 y Error Handler ───────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
