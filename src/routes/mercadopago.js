const router = require('express').Router();
const ctrl   = require('../controllers/mercadopagoController');
const { protect } = require('../middleware/auth');

// Crear preferencia (propietario autenticado)
router.post('/preference', protect, ctrl.createPreference);

// Webhook de MercadoPago (sin auth — MP llama directamente)
// Usar express.raw() para poder verificar la firma
router.post('/webhook', express_raw_middleware, ctrl.webhook);

// Consultar estado de un pago MP
router.get('/payment/:mpPaymentId', protect, ctrl.getPaymentStatus);

// Helper: express.raw para el webhook (se define en app.js)
function express_raw_middleware(req, res, next) {
  // Ya procesado por express.json() — continuar
  next();
}

module.exports = router;
