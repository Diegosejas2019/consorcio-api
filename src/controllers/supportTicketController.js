const SupportTicket = require('../models/SupportTicket');
const { sanitizeContext, buildTicketFilters } = require('../services/supportTicketService');
const supportNotificationService = require('../services/supportNotificationService');
const logger = require('../config/logger');

const allowedUpdateFields = ['status', 'priority', 'adminResponse'];

exports.createTicket = async (req, res, next) => {
  try {
    if (!['admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'No tenes permisos para crear tickets de soporte.',
      });
    }

    const ticket = await SupportTicket.create({
      organizationId: req.orgId,
      userId: req.user._id,
      userRole: req.user.role,
      type: req.body.type,
      title: req.body.title,
      description: req.body.description,
      context: sanitizeContext(req.body.context),
    });

    await ticket.populate([
      { path: 'userId', select: 'name email unit role' },
      { path: 'organizationId', select: 'name slug' },
    ]);

    supportNotificationService.notifyTicketCreated(ticket)
      .catch((err) => logger.warn(`Notificacion soporte fallo: ${err.message}`));

    res.status(201).json({
      success: true,
      message: 'Tu reporte fue enviado correctamente.',
      data: { ticket },
    });
  } catch (err) {
    next(err);
  }
};

exports.getTickets = async (req, res, next) => {
  try {
    const tickets = await SupportTicket.find(buildTicketFilters(req.query, req.orgId))
      .populate('userId', 'name email unit role')
      .sort({ createdAt: -1 })
      .select('-__v');

    res.json({ success: true, data: { tickets } });
  } catch (err) {
    next(err);
  }
};

exports.getMyTickets = async (req, res, next) => {
  try {
    const tickets = await SupportTicket.find({
      organizationId: req.orgId,
      userId: req.user._id,
      isActive: { $ne: false },
    })
      .sort({ createdAt: -1 })
      .select('-__v');

    res.json({ success: true, data: { tickets } });
  } catch (err) {
    next(err);
  }
};

exports.updateTicket = async (req, res, next) => {
  try {
    const ticket = await SupportTicket.findOne({
      _id: req.params.id,
      organizationId: req.orgId,
      isActive: { $ne: false },
    });

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket de soporte no encontrado.' });
    }

    allowedUpdateFields.forEach((field) => {
      if (req.body[field] !== undefined) ticket[field] = req.body[field];
    });

    if (['resolved', 'closed'].includes(ticket.status) && !ticket.resolvedAt) {
      ticket.resolvedAt = new Date();
    }

    ticket.updatedBy = req.user._id;
    await ticket.save();
    await ticket.populate('userId', 'name email unit role');

    res.json({
      success: true,
      message: 'Ticket actualizado correctamente.',
      data: { ticket },
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteTicket = async (req, res, next) => {
  try {
    const ticket = await SupportTicket.findOne({
      _id: req.params.id,
      organizationId: req.orgId,
      isActive: { $ne: false },
    });

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket de soporte no encontrado.' });
    }

    ticket.isActive = false;
    ticket.deletedAt = new Date();
    ticket.deletedBy = req.user._id;
    await ticket.save();

    res.json({ success: true, message: 'Ticket eliminado correctamente.' });
  } catch (err) {
    next(err);
  }
};
