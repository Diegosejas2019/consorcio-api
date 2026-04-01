const Config = require('../models/Config');

// ── GET /api/config — obtener configuración pública ───────────
exports.getConfig = async (req, res, next) => {
  try {
    // select: false excluye automáticamente mpAccessToken y mpWebhookSecret
    const config = await Config.getConfig();
    // Incluir mpPublicKey solo si el usuario es admin
    const data = config.toObject();
    if (req.user?.role !== 'admin') {
      delete data.mpPublicKey;
    }
    delete data.mpAccessToken;
    delete data.mpWebhookSecret;

    res.json({ success: true, data: { config: data } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/config — actualizar configuración (admin) ──────
exports.updateConfig = async (req, res, next) => {
  try {
    const allowed = [
      'expenseAmount', 'expenseMonth', 'expenseMonthCode',
      'lateFeePercent', 'dueDayOfMonth',
      'consortiumName', 'consortiumAddress', 'adminEmail', 'adminPhone',
      'mpPublicKey', 'mpAccessToken', 'mpWebhookSecret',
    ];

    const update = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

    const config = await Config.findOneAndUpdate(
      { _singleton: 'global' },
      update,
      { new: true, runValidators: true, upsert: true }
    );

    // No devolver credenciales sensibles
    const data = config.toObject();
    delete data.mpAccessToken;
    delete data.mpWebhookSecret;

    res.json({ success: true, data: { config: data } });
  } catch (err) {
    next(err);
  }
};
