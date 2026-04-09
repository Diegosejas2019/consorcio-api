const Claim           = require('../models/Claim');
const firebaseService = require('../services/firebaseService');
const User            = require('../models/User');
const logger          = require('../config/logger');

// ── GET /api/claims ───────────────────────────────────────────
exports.getClaims = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;

    const filter = {};
    if (req.user.role === 'owner') filter.owner = req.user._id;
    if (status) filter.status = status;

    const [claims, total] = await Promise.all([
      Claim.find(filter)
        .populate('owner', 'name unit email')
        .populate('resolvedBy', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-__v'),
      Claim.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { claims },
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/claims — crear reclamo (owner) ──────────────────
exports.createClaim = async (req, res, next) => {
  try {
    const { category, title, body } = req.body;

    const claim = await Claim.create({
      owner: req.user._id,
      category,
      title,
      body,
    });

    await claim.populate('owner', 'name unit email');

    // Notificar al admin por push
    const admins = await User.find({ role: 'admin', isActive: true }).select('+fcmToken');
    const tokens = admins.filter(a => a.fcmToken).map(a => a.fcmToken);
    if (tokens.length > 0) {
      firebaseService.sendMulticast(tokens, {
        title: '📋 Nuevo reclamo',
        body:  `${claim.owner.name} (${claim.owner.unit || 'sin unidad'}): ${title}`,
        data:  { type: 'new_claim', claimId: claim._id.toString() },
      }).catch(err => logger.warn(`Push admin reclamo falló: ${err.message}`));
    }

    logger.info(`Reclamo creado: "${claim.title}" por ${req.user.name}`);
    res.status(201).json({ success: true, data: { claim } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/claims/:id/status — cambiar estado (admin) ─────
exports.updateStatus = async (req, res, next) => {
  try {
    const { status, adminNote } = req.body;

    const claim = await Claim.findById(req.params.id)
      .populate('owner', 'name unit email fcmToken');
    if (!claim) return res.status(404).json({ success: false, message: 'Reclamo no encontrado.' });

    const prev = claim.status;
    claim.status = status;
    if (adminNote !== undefined) claim.adminNote = adminNote.trim();
    if (status === 'resolved' && prev !== 'resolved') {
      claim.resolvedBy = req.user._id;
      claim.resolvedAt = new Date();
    }
    await claim.save();

    // Notificar al propietario si se resolvió
    if (status === 'resolved' && prev !== 'resolved') {
      firebaseService.sendToUser(claim.owner._id, {
        title: '✅ Reclamo resuelto',
        body:  `Tu reclamo "${claim.title}" fue marcado como resuelto.`,
        data:  { type: 'claim_resolved', claimId: claim._id.toString() },
      }).catch(err => logger.warn(`Push owner reclamo resuelto falló: ${err.message}`));
    }

    logger.info(`Reclamo ${claim._id} → ${status} por ${req.user.name}`);
    res.json({ success: true, data: { claim } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/claims/:id — eliminar (owner pendiente / admin) ─
exports.deleteClaim = async (req, res, next) => {
  try {
    const claim = await Claim.findById(req.params.id);
    if (!claim) return res.status(404).json({ success: false, message: 'Reclamo no encontrado.' });

    if (req.user.role === 'owner') {
      if (claim.owner.toString() !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Acceso denegado.' });
      }
      if (claim.status !== 'open') {
        return res.status(400).json({ success: false, message: 'Solo podés eliminar reclamos abiertos.' });
      }
    }

    await claim.deleteOne();
    res.json({ success: true, message: 'Reclamo eliminado.' });
  } catch (err) {
    next(err);
  }
};
