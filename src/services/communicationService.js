const mongoose = require('mongoose');
const Notice = require('../models/Notice');
const NoticeReadReceipt = require('../models/NoticeReadReceipt');
const OrganizationMember = require('../models/OrganizationMember');
const Unit = require('../models/Unit');
const User = require('../models/User');
const firebaseService = require('./firebaseService');
const emailService = require('./emailService');
const logger = require('../config/logger');

const CATEGORY_VALUES = Notice.categories;
const PRIORITY_VALUES = Notice.priorities;
const STATUS_VALUES = Notice.statuses;
const TARGET_VALUES = Notice.targetTypes;

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === false) return value;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function parseMaybeJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function arr(value) {
  const parsed = parseMaybeJson(value, value);
  if (parsed === undefined || parsed === null || parsed === '') return [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map(String).filter(Boolean);
}

function objectIdStrings(values = []) {
  return [...new Set(arr(values).filter(id => mongoose.Types.ObjectId.isValid(id)))];
}

function normalizeTag(priority = 'normal', fallbackTag = 'info') {
  if (fallbackTag && ['info', 'warning', 'urgent'].includes(fallbackTag)) return fallbackTag;
  if (priority === 'urgent') return 'urgent';
  if (priority === 'high') return 'warning';
  return 'info';
}

function priorityFromTag(tag = 'info') {
  if (tag === 'urgent') return 'urgent';
  if (tag === 'warning') return 'high';
  return 'normal';
}

function normalizeChannels(raw = {}) {
  const parsed = parseMaybeJson(raw, raw) || {};
  return {
    app: true,
    email: toBool(parsed.email, false),
    push: toBool(parsed.push, false),
    whatsapp: toBool(parsed.whatsapp, false),
  };
}

function normalizeTargetFilters(raw = {}) {
  const parsed = parseMaybeJson(raw, raw) || {};
  return {
    unitIds: objectIdStrings(parsed.unitIds ?? parsed.units),
    userIds: objectIdStrings(parsed.userIds ?? parsed.users),
    includeInactive: toBool(parsed.includeInactive, false),
    onlyWithDebt: toBool(parsed.onlyWithDebt, false),
    periodId: parsed.periodId ? String(parsed.periodId).trim() : undefined,
  };
}

function normalizePayload(body = {}, files = []) {
  const channels = normalizeChannels(body.channels || {
    email: body.sendEmail,
    push: body.sendPush,
    whatsapp: body.whatsapp,
  });
  const priority = PRIORITY_VALUES.includes(body.priority) ? body.priority : priorityFromTag(body.tag);
  const status = STATUS_VALUES.includes(body.status) ? body.status : undefined;
  const targetType = TARGET_VALUES.includes(body.targetType) ? body.targetType : 'all';
  const targetFilters = normalizeTargetFilters(body.targetFilters || {
    unitIds: body.unitIds,
    userIds: body.userIds,
    includeInactive: body.includeInactive,
    onlyWithDebt: body.onlyWithDebt,
    periodId: body.periodId,
  });

  const data = {
    title: String(body.title || '').trim(),
    subject: String(body.subject || body.title || '').trim(),
    body: String(body.body || '').trim(),
    category: CATEGORY_VALUES.includes(body.category) ? body.category : 'general',
    priority,
    tag: normalizeTag(priority, body.tag),
    targetType,
    targetFilters,
    channels,
    readTrackingEnabled: toBool(body.readTrackingEnabled, true),
  };

  if (status) data.status = status;
  if (body.scheduledAt) data.scheduledAt = new Date(body.scheduledAt);
  if (files?.length) {
    data.attachments = files.map(f => ({
      url: f.path,
      publicId: f.filename,
      filename: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
    }));
  }
  return data;
}

function serializeNotice(notice, userId = null) {
  const obj = notice?.toObject ? notice.toObject() : { ...(notice || {}) };
  const priority = obj.tag === 'urgent'
    ? 'urgent'
    : (obj.tag === 'warning' && (!obj.priority || obj.priority === 'normal'))
      ? 'high'
      : (obj.priority || priorityFromTag(obj.tag));
  obj.subject = obj.subject || obj.title;
  obj.category = obj.category || 'general';
  obj.priority = priority;
  obj.status = obj.status || 'sent';
  obj.tag = obj.tag || normalizeTag(priority);
  obj.channels = { app: true, email: false, push: false, whatsapp: false, ...(obj.channels || {}) };
  obj.targetType = obj.targetType || 'all';
  obj.targetFilters = obj.targetFilters || { unitIds: [], userIds: [], includeInactive: false, onlyWithDebt: false };
  obj.readTrackingEnabled = obj.readTrackingEnabled !== false;
  if (userId) {
    obj.isRead = (obj.readBy || []).some(id => id.toString() === userId.toString());
    delete obj.readBy;
  }
  return obj;
}

function buildVisibleFilterForOwner(orgId, userId) {
  const now = new Date();
  return {
    organization: orgId,
    deletedAt: { $exists: false },
    $and: [
      {
        $or: [
          { status: 'sent' },
          { status: { $exists: false } },
        ],
      },
      {
        $or: [
          { sentAt: { $lte: now } },
          { sentAt: { $exists: false } },
        ],
      },
      {
        $or: [
          { targetType: { $in: ['all', 'owners'] } },
          { targetType: { $exists: false } },
          { recipientSnapshot: { $elemMatch: { user: userId } } },
        ],
      },
    ],
  };
}

async function getOwnerIdsForOrg(orgId, includeInactive = false) {
  const query = { organization: orgId, role: 'owner' };
  if (!includeInactive) query.isActive = true;
  const memberships = await OrganizationMember.find(query).select('user').lean();
  const memberIds = memberships.map(m => m.user).filter(Boolean);
  const legacyIds = await User.find({
    organization: orgId,
    role: 'owner',
    ...(includeInactive ? {} : { isActive: true }),
  }).distinct('_id');
  return [...new Map([...memberIds, ...legacyIds].map(id => [id.toString(), id])).values()];
}

async function buildRecipientRows(orgId, ownerIds) {
  const uniqueIds = [...new Set((ownerIds || []).map(id => id.toString()))];
  if (!uniqueIds.length) return [];
  const [users, units] = await Promise.all([
    User.find({ _id: { $in: uniqueIds }, isActive: true }).select('name email').lean(),
    Unit.find({ organization: orgId, owner: { $in: uniqueIds }, active: true }).select('owner name').lean(),
  ]);
  const userById = new Map(users.map(u => [u._id.toString(), u]));
  const unitByOwner = new Map();
  units.forEach(unit => {
    const ownerId = unit.owner?.toString();
    if (ownerId && !unitByOwner.has(ownerId)) unitByOwner.set(ownerId, unit);
  });
  return uniqueIds
    .map(id => {
      const user = userById.get(id);
      if (!user) return null;
      const unit = unitByOwner.get(id);
      return {
        user: user._id,
        unit: unit?._id,
        name: user.name,
        email: user.email,
        unitName: unit?.name,
      };
    })
    .filter(Boolean);
}

async function resolveCommunicationRecipients({ organizationId, targetType = 'all', targetFilters = {} }) {
  const filters = normalizeTargetFilters(targetFilters);
  const includeInactive = filters.includeInactive === true;
  let ownerIds = [];

  if (targetType === 'specific_users') {
    const allowed = await getOwnerIdsForOrg(organizationId, includeInactive);
    const allowedSet = new Set(allowed.map(id => id.toString()));
    ownerIds = filters.userIds.filter(id => allowedSet.has(id));
  } else if (targetType === 'specific_units') {
    ownerIds = await Unit.find({
      _id: { $in: filters.unitIds },
      organization: organizationId,
      active: true,
      owner: { $ne: null },
    }).distinct('owner');
  } else if (targetType === 'debtors') {
    const debtorUnitOwners = await Unit.find({
      organization: organizationId,
      active: true,
      isDebtor: true,
      owner: { $ne: null },
    }).distinct('owner');
    const debtorMembers = await OrganizationMember.find({
      organization: organizationId,
      role: 'owner',
      isActive: true,
      isDebtor: true,
    }).distinct('user');
    ownerIds = [...debtorUnitOwners, ...debtorMembers];
  } else if (targetType === 'tenants') {
    ownerIds = [];
  } else {
    ownerIds = await getOwnerIdsForOrg(organizationId, includeInactive);
  }

  return buildRecipientRows(organizationId, ownerIds);
}

function validateSendable(data, recipients = []) {
  if (!data.title || !data.body) return 'El titulo y el contenido son obligatorios.';
  if (!recipients.length) return 'No hay destinatarios validos para este comunicado.';
  if (data.status === 'scheduled') {
    if (!data.scheduledAt) return 'La fecha de programacion es obligatoria.';
    if (data.scheduledAt <= new Date()) return 'La fecha de programacion debe ser futura.';
  }
  return null;
}

async function deliverExternalChannels(notice, recipients) {
  const channels = { app: true, ...(notice.channels || {}) };
  const userIds = recipients.map(r => r.user).filter(Boolean);

  if (channels.push && userIds.length) {
    try {
      const users = await User.find({ _id: { $in: userIds }, isActive: true }).select('+fcmToken email').lean();
      const tokens = users.map(u => u.fcmToken).filter(Boolean);
      if (tokens.length) {
        const results = await firebaseService.sendMulticast(tokens, {
          title: notice.subject || notice.title,
          body: notice.body.slice(0, 120) + (notice.body.length > 120 ? '...' : ''),
          data: { type: 'new_notice', noticeId: notice._id.toString(), tag: notice.tag || 'info', priority: notice.priority || 'normal' },
        });
        const ok = results?.reduce((acc, r) => acc + r.successCount, 0) || 0;
        if (ok > 0) await Notice.findByIdAndUpdate(notice._id, { pushSent: true, pushSentAt: new Date() });
      }
    } catch (err) {
      logger.error(`[Comunicados] Error enviando push ${notice._id}: ${err.message}`, { stack: err.stack });
    }
  }

  if (channels.email && userIds.length) {
    User.find({ _id: { $in: userIds }, isActive: true })
      .then(async users => {
        const results = await Promise.allSettled(users.map(user => emailService.sendNoticeEmail(user, notice)));
        const ok = results.filter(r => r.status === 'fulfilled').length;
        const fail = results.filter(r => r.status === 'rejected').length;
        logger.info(`[Comunicados] Email comunicado "${notice.title}": ${ok} enviados, ${fail} fallidos`);
        if (ok > 0) await Notice.findByIdAndUpdate(notice._id, { emailSent: true, emailSentAt: new Date() });
      })
      .catch(err => logger.error(`[Comunicados] Error preparando email ${notice._id}: ${err.message}`));
  }
}

async function createCommunication({ organizationId, userId, body, files }) {
  const data = normalizePayload(body, files);
  const requestedAction = body.action || body.submitAction;

  if (requestedAction === 'draft') data.status = 'draft';
  else if (requestedAction === 'schedule' || data.scheduledAt) data.status = 'scheduled';
  else if (!data.status) data.status = 'sent';

  let recipients = [];
  if (data.status !== 'draft') {
    recipients = await resolveCommunicationRecipients({ organizationId, targetType: data.targetType, targetFilters: data.targetFilters });
    const error = validateSendable(data, recipients);
    if (error) {
      const err = new Error(error);
      err.statusCode = 400;
      throw err;
    }
  }

  if (data.status === 'sent') data.sentAt = new Date();
  const notice = await Notice.create({
    ...data,
    organization: organizationId,
    author: userId,
    recipientSnapshot: data.status === 'draft' ? [] : recipients,
  });
  if (notice.status === 'sent') deliverExternalChannels(notice, recipients);
  return notice;
}

async function updateCommunication({ id, organizationId, userId, body, files }) {
  const notice = await Notice.findOne({ _id: id, organization: organizationId, deletedAt: { $exists: false } });
  if (!notice) return null;
  if (!['draft', 'scheduled'].includes(notice.status || 'sent')) {
    const err = new Error('Solo se pueden editar comunicados en borrador o programados.');
    err.statusCode = 400;
    throw err;
  }

  const data = normalizePayload({
    title: notice.title,
    subject: notice.subject,
    body: notice.body,
    category: notice.category,
    priority: notice.priority,
    tag: notice.tag,
    status: notice.status,
    scheduledAt: notice.scheduledAt,
    targetType: notice.targetType,
    targetFilters: notice.targetFilters,
    channels: notice.channels,
    readTrackingEnabled: notice.readTrackingEnabled,
    ...body,
  }, files);
  Object.entries(data).forEach(([key, value]) => {
    if (key === 'attachments') return;
    notice[key] = value;
  });
  if (data.attachments?.length) notice.attachments.push(...data.attachments);
  notice.updatedBy = userId;

  if (notice.status === 'scheduled') {
    const recipients = await resolveCommunicationRecipients({
      organizationId,
      targetType: notice.targetType,
      targetFilters: notice.targetFilters,
    });
    const error = validateSendable(notice, recipients);
    if (error) {
      const err = new Error(error);
      err.statusCode = 400;
      throw err;
    }
    notice.recipientSnapshot = recipients;
  }
  await notice.save();
  return notice;
}

async function sendCommunicationNow({ id, organizationId, userId }) {
  const notice = await Notice.findOne({ _id: id, organization: organizationId, deletedAt: { $exists: false } });
  if (!notice) return null;
  if (notice.status === 'cancelled') {
    const err = new Error('No se puede enviar un comunicado cancelado.');
    err.statusCode = 400;
    throw err;
  }
  const recipients = await resolveCommunicationRecipients({
    organizationId,
    targetType: notice.targetType || 'all',
    targetFilters: notice.targetFilters || {},
  });
  notice.status = 'sent';
  const error = validateSendable(notice, recipients);
  if (error) {
    const err = new Error(error);
    err.statusCode = 400;
    throw err;
  }
  notice.sentAt = new Date();
  notice.scheduledAt = undefined;
  notice.updatedBy = userId;
  notice.recipientSnapshot = recipients;
  await notice.save();
  deliverExternalChannels(notice, recipients);
  return notice;
}

async function scheduleCommunication({ id, organizationId, userId, scheduledAt }) {
  const notice = await Notice.findOne({ _id: id, organization: organizationId, deletedAt: { $exists: false } });
  if (!notice) return null;
  notice.status = 'scheduled';
  notice.scheduledAt = new Date(scheduledAt);
  notice.updatedBy = userId;
  const recipients = await resolveCommunicationRecipients({
    organizationId,
    targetType: notice.targetType || 'all',
    targetFilters: notice.targetFilters || {},
  });
  const error = validateSendable(notice, recipients);
  if (error) {
    const err = new Error(error);
    err.statusCode = 400;
    throw err;
  }
  notice.recipientSnapshot = recipients;
  await notice.save();
  return notice;
}

async function cancelCommunication({ id, organizationId, userId }) {
  const notice = await Notice.findOne({ _id: id, organization: organizationId, deletedAt: { $exists: false } });
  if (!notice) return null;
  if (notice.status === 'sent') {
    const err = new Error('No se puede cancelar un comunicado ya enviado.');
    err.statusCode = 400;
    throw err;
  }
  notice.status = 'cancelled';
  notice.updatedBy = userId;
  await notice.save();
  return notice;
}

async function processScheduledCommunications({ organizationId = null, now = new Date(), userId = null } = {}) {
  const filter = { status: 'scheduled', scheduledAt: { $lte: now }, deletedAt: { $exists: false } };
  if (organizationId) filter.organization = organizationId;
  const notices = await Notice.find(filter);
  const processed = [];
  const failed = [];

  for (const notice of notices) {
    try {
      const sent = await sendCommunicationNow({ id: notice._id, organizationId: notice.organization, userId });
      processed.push(sent);
    } catch (err) {
      failed.push({ id: notice._id, message: err.message });
      logger.error(`[Comunicados] Error procesando programado ${notice._id}: ${err.message}`);
    }
  }
  return { processed, failed };
}

async function markCommunicationAsRead({ id, organizationId, userId, unread = false }) {
  const notice = await Notice.findOne({ _id: id, organization: organizationId });
  if (!notice) return null;
  if (unread) {
    await Promise.all([
      Notice.updateOne({ _id: id, organization: organizationId }, { $pull: { readBy: userId } }),
      NoticeReadReceipt.deleteOne({ organization: organizationId, notice: id, user: userId }),
    ]);
    return notice;
  }
  const unit = await Unit.findOne({ organization: organizationId, owner: userId, active: true }).select('_id').lean();
  await Promise.all([
    Notice.updateOne({ _id: id, organization: organizationId }, { $addToSet: { readBy: userId } }),
    NoticeReadReceipt.findOneAndUpdate(
      { organization: organizationId, notice: id, user: userId },
      { $setOnInsert: { unit: unit?._id, readAt: new Date() } },
      { upsert: true, new: true }
    ),
  ]);
  return notice;
}

async function getCommunicationStats({ id, organizationId }) {
  const notice = await Notice.findOne({ _id: id, organization: organizationId, deletedAt: { $exists: false } });
  if (!notice) return null;
  const recipients = notice.recipientSnapshot?.length
    ? notice.recipientSnapshot
    : await resolveCommunicationRecipients({
        organizationId,
        targetType: notice.targetType || 'all',
        targetFilters: notice.targetFilters || {},
      });
  const receipts = await NoticeReadReceipt.find({ organization: organizationId, notice: id })
    .populate('user', 'name email')
    .populate('unit', 'name')
    .lean();
  const legacyRead = (notice.readBy || []).map(id => id.toString());
  const readIds = new Set([...receipts.map(r => r.user?._id?.toString() || r.user?.toString()), ...legacyRead].filter(Boolean));
  const recipientsView = recipients.map(r => ({
    user: r.user,
    unit: r.unit,
    name: r.name,
    email: r.email,
    unitName: r.unitName,
    read: readIds.has(r.user?.toString()),
    readAt: receipts.find(receipt => (receipt.user?._id || receipt.user)?.toString() === r.user?.toString())?.readAt,
  }));
  const read = recipientsView.filter(r => r.read);
  const unread = recipientsView.filter(r => !r.read);
  return {
    totalRecipients: recipientsView.length,
    readCount: read.length,
    unreadCount: unread.length,
    readPercentage: recipientsView.length ? Math.round((read.length / recipientsView.length) * 100) : 0,
    read,
    unread,
  };
}

module.exports = {
  normalizePayload,
  serializeNotice,
  buildVisibleFilterForOwner,
  resolveCommunicationRecipients,
  createCommunication,
  updateCommunication,
  sendCommunicationNow,
  scheduleCommunication,
  processScheduledCommunications,
  cancelCommunication,
  markCommunicationAsRead,
  getCommunicationStats,
};
