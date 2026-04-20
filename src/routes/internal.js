const express    = require('express');
const controller = require('../controllers/internalController');

const router = express.Router();

// ── Middleware: validar x-internal-key ───────────────────────
router.use((req, res, next) => {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ success: false, message: 'No autorizado' });
  }
  next();
});

router.post('/create-organization', controller.createOrganization);

module.exports = router;
