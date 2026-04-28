const Vote            = require('../models/Vote');
const VoteResponse    = require('../models/VoteResponse');
const User            = require('../models/User');
const firebaseService = require('../services/firebaseService');
const logger          = require('../config/logger');

// ── GET /api/votes ────────────────────────────────────────────
// Admin: todas las votaciones. Owner: solo abiertas + las cerradas donde votó.
exports.getVotes = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;

    const filter = { organization: req.orgId };
    if (status) filter.status = status;

    const [votes, total] = await Promise.all([
      Vote.find(filter)
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-__v'),
      Vote.countDocuments(filter),
    ]);

    // Para owners: enriquecer cada voto con si ya votó
    let enriched = votes;
    if (req.user.role === 'owner') {
      const voteIds = votes.map((v) => v._id);
      const responses = await VoteResponse.find({
        vote: { $in: voteIds },
        owner: req.user._id,
      }).select('vote optionIndex');

      const responseMap = {};
      responses.forEach((r) => { responseMap[r.vote.toString()] = r.optionIndex; });

      enriched = votes.map((v) => {
        const obj = v.toObject();
        const optionIndex = responseMap[v._id.toString()];
        obj.myVote = optionIndex !== undefined ? optionIndex : null;
        // Owners solo ven resultados si ya votaron, la votación está cerrada, o venció
        const isExpired = v.endsAt && new Date() > new Date(v.endsAt);
        if (optionIndex === undefined && v.status === 'open' && !isExpired) {
          obj.options = obj.options.map((o) => ({ label: o.label }));
        }
        return obj;
      });
    }

    res.json({
      success: true,
      data: { votes: enriched },
      pagination: {
        total,
        page:  Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/votes/:id ────────────────────────────────────────
exports.getVote = async (req, res, next) => {
  try {
    const vote = await Vote.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('createdBy', 'name')
      .populate('closedBy', 'name');
    if (!vote) return res.status(404).json({ success: false, message: 'Votación no encontrada.' });

    const obj = vote.toObject();

    if (req.user.role === 'owner') {
      const response = await VoteResponse.findOne({ vote: vote._id, owner: req.user._id });
      obj.myVote = response ? response.optionIndex : null;
      // Ocultar conteos si la votación sigue abierta, no venció, y el owner no votó aún
      const isExpired = vote.endsAt && new Date() > new Date(vote.endsAt);
      if (!response && vote.status === 'open' && !isExpired) {
        obj.options = obj.options.map((o) => ({ label: o.label }));
      }
    } else {
      // Admin: agregar quién votó y por qué opción
      const responses = await VoteResponse.find({ vote: vote._id })
        .populate('owner', 'name unit');
      obj.responses = responses;
    }

    res.json({ success: true, data: { vote: obj } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/votes — crear votación (admin) ──────────────────
exports.createVote = async (req, res, next) => {
  try {
    const { title, description, options, endsAt, sendPush = true } = req.body;

    const optionDocs = options.map((label) => ({ label: label.trim(), votes: 0 }));

    const vote = await Vote.create({
      organization: req.orgId,
      title,
      description,
      options: optionDocs,
      endsAt: endsAt ? new Date(endsAt) : undefined,
      createdBy: req.user._id,
    });

    // Notificar a todos los propietarios
    if (sendPush) {
      const owners = await User.find({ organization: req.orgId, role: 'owner', isActive: true })
        .select('+fcmToken');
      const tokens = owners.filter((o) => o.fcmToken).map((o) => o.fcmToken);

      if (tokens.length > 0) {
        firebaseService
          .sendMulticast(tokens, {
            title: '🗳️ Nueva votación',
            body:  title,
            data:  { type: 'new_vote', voteId: vote._id.toString() },
          })
          .then(async (results) => {
            const success = results?.reduce((acc, r) => acc + r.successCount, 0) ?? 0;
            if (success > 0) {
              await Vote.findByIdAndUpdate(vote._id, { pushSent: true, pushSentAt: new Date() });
            }
          })
          .catch((err) => logger.warn(`[Push] Votación ${vote._id}: ${err.message}`));
      }
    }

    await vote.populate('createdBy', 'name');
    logger.info(`Votación creada: "${vote.title}" por ${req.user.name}`);
    res.status(201).json({ success: true, data: { vote } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/votes/:id — editar votación (admin, solo si abierta) ──
exports.updateVote = async (req, res, next) => {
  try {
    const vote = await Vote.findOne({ _id: req.params.id, organization: req.orgId });
    if (!vote) return res.status(404).json({ success: false, message: 'Votación no encontrada.' });
    if (vote.status === 'closed') {
      return res.status(400).json({ success: false, message: 'No se puede editar una votación cerrada.' });
    }

    const totalVotes = vote.options.reduce((s, o) => s + o.votes, 0);
    if (totalVotes > 0 && req.body.options) {
      return res.status(400).json({
        success: false,
        message: 'No se pueden modificar las opciones una vez que hay votos registrados.',
      });
    }

    const { title, description, endsAt, options } = req.body;
    if (title !== undefined)       vote.title = title;
    if (description !== undefined) vote.description = description;
    if (endsAt !== undefined)      vote.endsAt = endsAt ? new Date(endsAt) : undefined;
    if (options !== undefined && totalVotes === 0) {
      vote.options = options.map((label) => ({ label: label.trim(), votes: 0 }));
    }

    await vote.save();
    await vote.populate('createdBy', 'name');

    res.json({ success: true, data: { vote } });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/votes/:id/close — cerrar votación (admin) ─────
exports.closeVote = async (req, res, next) => {
  try {
    const vote = await Vote.findOne({ _id: req.params.id, organization: req.orgId });
    if (!vote) return res.status(404).json({ success: false, message: 'Votación no encontrada.' });
    if (vote.status === 'closed') {
      return res.status(400).json({ success: false, message: 'La votación ya está cerrada.' });
    }

    vote.status   = 'closed';
    vote.closedBy = req.user._id;
    vote.closedAt = new Date();
    await vote.save();
    await vote.populate('createdBy', 'name');
    await vote.populate('closedBy', 'name');

    logger.info(`Votación cerrada: "${vote.title}" por ${req.user.name}`);
    res.json({ success: true, data: { vote } });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /api/votes/:id — eliminar votación (admin) ─────────
exports.deleteVote = async (req, res, next) => {
  try {
    const vote = await Vote.findOneAndDelete({ _id: req.params.id, organization: req.orgId });
    if (!vote) return res.status(404).json({ success: false, message: 'Votación no encontrada.' });

    // Eliminar todas las respuestas asociadas
    await VoteResponse.deleteMany({ vote: vote._id });

    logger.info(`Votación eliminada: "${vote.title}" por ${req.user.name}`);
    res.json({ success: true, message: 'Votación eliminada.' });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/votes/:id/cast — emitir voto (owner) ───────────
exports.castVote = async (req, res, next) => {
  try {
    const { optionIndex } = req.body;

    const vote = await Vote.findOne({ _id: req.params.id, organization: req.orgId });
    if (!vote) return res.status(404).json({ success: false, message: 'Votación no encontrada.' });
    if (vote.status === 'closed') {
      return res.status(400).json({ success: false, message: 'Esta votación ya está cerrada.' });
    }
    if (vote.endsAt && new Date() > vote.endsAt) {
      return res.status(400).json({ success: false, message: 'El plazo de la votación ha vencido.' });
    }
    if (optionIndex < 0 || optionIndex >= vote.options.length) {
      return res.status(400).json({ success: false, message: 'Opción inválida.' });
    }

    // Verificar si ya votó
    const existing = await VoteResponse.findOne({ vote: vote._id, owner: req.user._id });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Ya emitiste tu voto en esta votación.' });
    }

    // Registrar respuesta y actualizar contador atómicamente
    await VoteResponse.create({
      vote:         vote._id,
      organization: req.orgId,
      owner:        req.user._id,
      optionIndex,
    });

    await Vote.findByIdAndUpdate(vote._id, {
      $inc: { [`options.${optionIndex}.votes`]: 1 },
    });

    // Devolver el voto actualizado con resultados para que el owner vea el estado
    const updatedVote = await Vote.findById(vote._id).populate('createdBy', 'name');
    const obj = updatedVote.toObject();
    obj.myVote = optionIndex;

    logger.info(`Voto emitido: votación "${vote.title}" opción ${optionIndex} por ${req.user.name}`);
    res.json({ success: true, data: { vote: obj } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Ya emitiste tu voto en esta votación.' });
    }
    next(err);
  }
};

// ── GET /api/votes/:id/results — resultados detallados (admin) ─
exports.getResults = async (req, res, next) => {
  try {
    const vote = await Vote.findOne({ _id: req.params.id, organization: req.orgId })
      .populate('createdBy', 'name')
      .populate('closedBy', 'name');
    if (!vote) return res.status(404).json({ success: false, message: 'Votación no encontrada.' });

    const responses = await VoteResponse.find({ vote: vote._id })
      .populate('owner', 'name unit email')
      .sort({ createdAt: 1 });

    const totalVotes = vote.options.reduce((s, o) => s + o.votes, 0);
    const options = vote.options.map((o, idx) => ({
      index:      idx,
      label:      o.label,
      votes:      o.votes,
      percentage: totalVotes > 0 ? Math.round((o.votes / totalVotes) * 100) : 0,
    }));

    res.json({
      success: true,
      data: {
        vote: {
          _id:         vote._id,
          title:       vote.title,
          description: vote.description,
          status:      vote.status,
          statusLabel: vote.statusLabel,
          endsAt:      vote.endsAt,
          createdBy:   vote.createdBy,
          closedBy:    vote.closedBy,
          closedAt:    vote.closedAt,
          createdAt:   vote.createdAt,
        },
        options,
        totalVotes,
        responses,
      },
    });
  } catch (err) {
    next(err);
  }
};
