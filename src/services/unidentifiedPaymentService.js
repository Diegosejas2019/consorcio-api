const XLSX = require('xlsx');
const UnidentifiedPayment = require('../models/UnidentifiedPayment');
const UnidentifiedPaymentEvent = require('../models/UnidentifiedPaymentEvent');
const Payment = require('../models/Payment');
const User = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Unit = require('../models/Unit');
const Organization = require('../models/Organization');

const COLUMN_MAP = {
  fecha: 'paymentDate', 'fecha operacion': 'paymentDate', 'fecha de operacion': 'paymentDate',
  'fecha valor': 'paymentDate', 'fecha de acreditacion': 'paymentDate', date: 'paymentDate',
  importe: 'amount', monto: 'amount', amount: 'amount', 'importe acreditado': 'amount',
  credito: 'amount', crédito: 'amount', haber: 'amount', 'credito ars': 'amount',
  referencia: 'reference', concepto: 'reference', comprobante: 'reference', reference: 'reference',
  'numero comprobante': 'reference', 'nro comprobante': 'reference', 'id transaccion': 'reference',
  titular: 'senderName', ordenante: 'senderName', remitente: 'senderName',
  'nombre ordenante': 'senderName', 'nombre remitente': 'senderName', 'nombre del remitente': 'senderName',
  cbu: 'senderAccount', 'cuenta origen': 'senderAccount', 'cbu origen': 'senderAccount',
  alias: 'senderAccount', 'alias origen': 'senderAccount',
  descripcion: 'description', descripción: 'description', observaciones: 'description',
  detalle: 'description', notas: 'description',
};

const VALID_PAYMENT_METHODS = ['transferencia', 'deposito', 'efectivo', 'mercadopago', 'otro'];

function parseStatementFile(buffer, filename) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: '' });

  if (!rawRows.length) return { rows: [] };

  const rows = rawRows.map(rawRow => {
    const normalized = {};
    for (const [key, val] of Object.entries(rawRow)) {
      const mappedField = COLUMN_MAP[key.toLowerCase().trim()];
      if (mappedField && val !== '' && val !== null && val !== undefined) {
        if (!normalized[mappedField]) normalized[mappedField] = String(val).trim();
      }
    }
    return normalized;
  }).filter(r => Object.keys(r).length > 0);

  return { rows };
}

function parseFlexibleDate(val) {
  if (!val) return null;
  const str = String(val).trim();

  // XLSX devuelve fechas en formato 'D/M/YYYY' o 'YYYY-MM-DD' con raw:false
  // Probar DD/MM/YYYY
  const dmY = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmY) {
    const d = new Date(`${dmY[3]}-${dmY[2].padStart(2, '0')}-${dmY[1].padStart(2, '0')}T12:00:00Z`);
    if (!isNaN(d)) return d;
  }
  // YYYY-MM-DD
  const ymd = str.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
  if (ymd) {
    const d = new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T12:00:00Z`);
    if (!isNaN(d)) return d;
  }
  // Fallback genérico
  const d = new Date(str);
  if (!isNaN(d)) return d;
  return null;
}

function validateRow(row, rowNumber) {
  const amountRaw = String(row.amount || '').replace(/\./g, '').replace(',', '.');
  const amount = parseFloat(amountRaw);
  if (!row.amount || isNaN(amount) || amount <= 0) {
    return { data: null, error: `Fila ${rowNumber}: importe inválido o ausente ('${row.amount || ''}')` };
  }

  if (!row.paymentDate) {
    return { data: null, error: `Fila ${rowNumber}: fecha de pago ausente` };
  }
  const paymentDate = parseFlexibleDate(row.paymentDate);
  if (!paymentDate) {
    return { data: null, error: `Fila ${rowNumber}: fecha inválida ('${row.paymentDate}')` };
  }
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  if (paymentDate > now) {
    return { data: null, error: `Fila ${rowNumber}: la fecha no puede ser futura (${row.paymentDate})` };
  }

  let paymentMethod = (row.paymentMethod || '').toLowerCase().trim();
  if (!paymentMethod || !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    paymentMethod = 'transferencia';
  }

  return {
    data: {
      amount,
      paymentDate,
      paymentMethod,
      reference: row.reference || undefined,
      senderName: row.senderName || undefined,
      senderAccount: row.senderAccount || undefined,
      description: row.description || undefined,
    },
    error: null,
  };
}

async function checkBulkDuplicates(validRows, orgId) {
  if (!validRows.length) return new Set();

  const dates = validRows.map(r => r.paymentDate);
  const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));
  minDate.setDate(minDate.getDate() - 7);

  const existing = await UnidentifiedPayment.find({
    organization: orgId,
    isDeleted: false,
    paymentDate: { $gte: minDate, $lte: maxDate },
  }).select('amount paymentDate reference').lean();

  const duplicateRowNumbers = new Set();

  validRows.forEach((row, idx) => {
    const rowNum = idx + 2;
    for (const ex of existing) {
      const sameAmount = Math.abs(ex.amount - row.amount) < 0.01;
      const sameDay =
        ex.paymentDate.getFullYear() === row.paymentDate.getFullYear() &&
        ex.paymentDate.getMonth() === row.paymentDate.getMonth() &&
        ex.paymentDate.getDate() === row.paymentDate.getDate();
      const sameRef = row.reference && ex.reference &&
        row.reference.toLowerCase().trim() === ex.reference.toLowerCase().trim();

      if (sameAmount && sameDay && (sameRef || (!row.reference && !ex.reference))) {
        duplicateRowNumbers.add(rowNum);
        break;
      }
    }
  });

  return duplicateRowNumbers;
}

async function bulkCreateStatements(orgId, userId, rows, filename) {
  if (!rows.length) return { created: 0, ids: [] };

  const docs = rows.map(row => ({
    organization: orgId,
    amount: row.amount,
    paymentDate: row.paymentDate,
    paymentMethod: row.paymentMethod,
    reference: row.reference,
    senderName: row.senderName,
    senderAccount: row.senderAccount,
    description: row.description,
    status: 'pending',
    createdBy: userId,
  }));

  const inserted = await UnidentifiedPayment.insertMany(docs, { ordered: false });

  const events = inserted.map(p => ({
    organization: orgId,
    unidentifiedPayment: p._id,
    eventType: 'created',
    userId,
    metadata: {
      source: 'bank_import',
      filename,
      batchSize: inserted.length,
      amount: p.amount,
      paymentMethod: p.paymentMethod,
    },
  }));
  await UnidentifiedPaymentEvent.insertMany(events, { ordered: false });

  return { created: inserted.length, ids: inserted.map(p => p._id) };
}

const logger = {
  error: (...args) => console.error('[UnidentifiedPaymentService]', ...args),
  warn: (...args) => console.warn('[UnidentifiedPaymentService]', ...args),
  info: (...args) => console.info('[UnidentifiedPaymentService]', ...args),
};

async function createUnidentifiedPayment(orgId, data, userId) {
  try {
    const { amount, paymentDate, paymentMethod, reference, senderName, senderAccount, description } = data;

    if (!amount || amount <= 0) {
      throw new Error('El importe es obligatorio y debe ser mayor a 0');
    }
    if (!paymentDate) {
      throw new Error('La fecha de pago es obligatoria');
    }
    if (!paymentMethod) {
      throw new Error('El método de pago es obligatorio');
    }

    const paymentDateObj = new Date(paymentDate);
    if (paymentDateObj > new Date()) {
      throw new Error('La fecha de pago no puede ser futura');
    }

    const duplicate = await UnidentifiedPayment.findOne({
      organization: orgId,
      amount,
      paymentDate: paymentDateObj,
      paymentMethod,
      reference: reference || undefined,
      isDeleted: false,
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });

    if (duplicate) {
      throw new Error('Ya existe un pago no identificado con el mismo importe, fecha, método y referencia en los últimos 7 días');
    }

    const unidentifiedPayment = new UnidentifiedPayment({
      organization: orgId,
      amount,
      paymentDate: paymentDateObj,
      paymentMethod,
      reference,
      senderName,
      senderAccount,
      description,
      status: 'pending',
      createdBy: userId,
    });

    await unidentifiedPayment.save();

    await UnidentifiedPaymentEvent.create({
      organization: orgId,
      unidentifiedPayment: unidentifiedPayment._id,
      eventType: 'created',
      userId,
      metadata: { amount, paymentMethod, paymentDate },
    });

    return unidentifiedPayment;
  } catch (error) {
    logger.error('createUnidentifiedPayment error:', error.message);
    throw error;
  }
}

async function updateUnidentifiedPayment(id, data, userId) {
  try {
    const unidentifiedPayment = await UnidentifiedPayment.findById(id);

    if (!unidentifiedPayment) {
      throw new Error('No se encontró el pago no identificado');
    }

    if (unidentifiedPayment.isDeleted) {
      throw new Error('No se puede editar un pago eliminado');
    }

    if (unidentifiedPayment.status !== 'pending') {
      throw new Error('Solo se pueden editar pagos en estado pendiente');
    }

    const allowedFields = ['amount', 'paymentDate', 'paymentMethod', 'reference', 'senderName', 'senderAccount', 'description'];

    allowedFields.forEach(field => {
      if (data[field] !== undefined) {
        unidentifiedPayment[field] = data[field];
      }
    });

    unidentifiedPayment.updatedBy = userId;
    await unidentifiedPayment.save();

    await UnidentifiedPaymentEvent.create({
      organization: unidentifiedPayment.organization,
      unidentifiedPayment: unidentifiedPayment._id,
      eventType: 'updated',
      userId,
      metadata: data,
    });

    return unidentifiedPayment;
  } catch (error) {
    logger.error('updateUnidentifiedPayment error:', error.message);
    throw error;
  }
}

async function getUnidentifiedPayments(orgId, filters = {}, pagination = {}) {
  try {
    const { status, paymentMethod, dateFrom, dateTo, amountMin, amountMax, search } = filters;
    const { page = 1, limit = 20 } = pagination;

    const query = {
      organization: orgId,
      isDeleted: false,
    };

    if (status) {
      query.status = status;
    }

    if (paymentMethod) {
      query.paymentMethod = paymentMethod;
    }

    if (dateFrom || dateTo) {
      query.paymentDate = {};
      if (dateFrom) query.paymentDate.$gte = new Date(dateFrom);
      if (dateTo) query.paymentDate.$lte = new Date(dateTo);
    }

    if (amountMin || amountMax) {
      query.amount = {};
      if (amountMin) query.amount.$gte = Number(amountMin);
      if (amountMax) query.amount.$lte = Number(amountMax);
    }

    if (search) {
      query.$or = [
        { senderName: { $regex: search, $options: 'i' } },
        { reference: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const total = await UnidentifiedPayment.countDocuments(query);
    const data = await UnidentifiedPayment.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('createdBy', 'name email')
      .populate('matchedOwnerId', 'name email')
      .populate('matchedUnitId', 'name')
      .populate('associatedPaymentId');

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  } catch (error) {
    logger.error('getUnidentifiedPayments error:', error.message);
    throw error;
  }
}

async function getUnidentifiedPaymentById(id, orgId) {
  try {
    const unidentifiedPayment = await UnidentifiedPayment.findOne({
      _id: id,
      organization: orgId,
      isDeleted: false,
    }).populate('createdBy', 'name email')
      .populate('matchedOwnerId', 'name email')
      .populate('matchedUnitId', 'name')
      .populate('associatedPaymentId')
      .populate('associatedBy', 'name email')
      .populate('rejectedBy', 'name email')
      .populate('archivedBy', 'name email')
      .populate('deletedBy', 'name email');

    if (!unidentifiedPayment) {
      throw new Error('No se encontró el pago no identificado');
    }

    return unidentifiedPayment;
  } catch (error) {
    logger.error('getUnidentifiedPaymentById error:', error.message);
    throw error;
  }
}

async function findPaymentMatchSuggestions(orgId, unidentifiedPaymentId) {
  try {
    const unidentifiedPayment = await UnidentifiedPayment.findOne({
      _id: unidentifiedPaymentId,
      organization: orgId,
      isDeleted: false,
    });

    if (!unidentifiedPayment) {
      throw new Error('No se encontró el pago no identificado');
    }

    const suggestions = [];

    const exactMatchOwners = await OrganizationMember.find({
      organization: orgId,
      role: 'owner',
      isActive: true,
      isDebtor: true,
    }).populate('user', 'name').populate('balance');

    for (const membership of exactMatchOwners) {
      const pendingPayments = await Payment.find({
        organization: orgId,
        owner: membership.user._id,
        status: 'pending',
      });

      const totalDebt = pendingPayments.reduce((sum, p) => sum + p.amount, 0);
      const debtAmount = membership.balance < 0 ? Math.abs(membership.balance) : totalDebt;

      if (debtAmount === unidentifiedPayment.amount) {
        const units = await Unit.find({
          organization: orgId,
          owner: membership.user._id,
          active: true,
        });

        suggestions.push({
          ownerId: membership.user._id,
          ownerName: membership.user.name,
          unitId: units.length > 0 ? units[0]._id : null,
          unitName: units.length > 0 ? units[0].name : null,
          debtAmount,
          periods: pendingPayments.map(p => p.month).filter(Boolean),
          confidence: 'exact',
          reason: 'El importe coincide exactamente con la deuda pendiente',
        });
      } else if (debtAmount > 0) {
        const tolerance = unidentifiedPayment.amount * 0.05;
        if (Math.abs(debtAmount - unidentifiedPayment.amount) <= tolerance) {
          const units = await Unit.find({
            organization: orgId,
            owner: membership.user._id,
            active: true,
          });

          suggestions.push({
            ownerId: membership.user._id,
            ownerName: membership.user.name,
            unitId: units.length > 0 ? units[0]._id : null,
            unitName: units.length > 0 ? units[0].name : null,
            debtAmount,
            periods: pendingPayments.map(p => p.month).filter(Boolean),
            confidence: 'high',
            reason: 'El importe coincide dentro del 5% de tolerancia',
          });
        }
      }
    }

    if (unidentifiedPayment.senderName) {
      const senderNameLower = unidentifiedPayment.senderName.toLowerCase();
      const ownersByName = await User.find({
        name: { $regex: senderNameLower, $options: 'i' },
      });

      for (const owner of ownersByName) {
        const membership = await OrganizationMember.findOne({
          user: owner._id,
          organization: orgId,
          role: 'owner',
          isActive: true,
        });

        if (membership) {
          const alreadySuggested = suggestions.some(s => s.ownerId.toString() === owner._id.toString());
          if (!alreadySuggested) {
            const units = await Unit.find({
              organization: orgId,
              owner: owner._id,
              active: true,
            });

            suggestions.push({
              ownerId: owner._id,
              ownerName: owner.name,
              unitId: units.length > 0 ? units[0]._id : null,
              unitName: units.length > 0 ? units[0].name : null,
              debtAmount: membership.balance < 0 ? Math.abs(membership.balance) : 0,
              periods: [],
              confidence: 'medium',
              reason: 'El nombre del depositante coincide con un propietario',
            });
          }
        }
      }
    }

    if (unidentifiedPayment.reference) {
      const unitsWithMatchingName = await Unit.find({
        organization: orgId,
        name: { $regex: unidentifiedPayment.reference, $options: 'i' },
        active: true,
      });

      for (const unit of unitsWithMatchingName) {
        if (unit.owner) {
          const owner = await User.findById(unit.owner);
          const membership = await OrganizationMember.findOne({
            user: unit.owner,
            organization: orgId,
            role: 'owner',
            isActive: true,
          });

          if (owner && membership) {
            const alreadySuggested = suggestions.some(s => s.ownerId.toString() === owner._id.toString());
            if (!alreadySuggested) {
              suggestions.push({
                ownerId: owner._id,
                ownerName: owner.name,
                unitId: unit._id,
                unitName: unit.name,
                debtAmount: membership.balance < 0 ? Math.abs(membership.balance) : 0,
                periods: [],
                confidence: 'medium',
                reason: 'La referencia contiene el nombre de una unidad',
              });
            }
          }
        }
      }
    }

    await UnidentifiedPaymentEvent.create({
      organization: orgId,
      unidentifiedPayment: unidentifiedPaymentId,
      eventType: 'suggestion_viewed',
      userId: undefined,
      metadata: { suggestionsCount: suggestions.length },
    });

    return suggestions;
  } catch (error) {
    logger.error('findPaymentMatchSuggestions error:', error.message);
    throw error;
  }
}

async function associateUnidentifiedPayment(id, data, userId) {
  try {
    const { ownerId, unitId, period, amountApplied } = data;

    const unidentifiedPayment = await UnidentifiedPayment.findOne({
      _id: id,
      isDeleted: false,
    });

    if (!unidentifiedPayment) {
      throw new Error('No se encontró el pago no identificado');
    }

    if (unidentifiedPayment.status !== 'pending') {
      throw new Error('Solo se pueden asociar pagos en estado pendiente');
    }

    if (!ownerId) {
      throw new Error('El propietario es obligatorio');
    }

    const ownerMembership = await OrganizationMember.findOne({
      user: ownerId,
      organization: unidentifiedPayment.organization,
      role: 'owner',
      isActive: true,
    });

    if (!ownerMembership) {
      throw new Error('El propietario no pertenece a esta organización');
    }

    if (unitId) {
      const unit = await Unit.findOne({
        _id: unitId,
        organization: unidentifiedPayment.organization,
        owner: ownerId,
      });

      if (!unit) {
        throw new Error('La unidad no existe o no pertenece a este propietario');
      }
    }

    const pendingPayments = await Payment.find({
      organization: unidentifiedPayment.organization,
      owner: ownerId,
      status: 'pending',
    });

    const totalDebt = pendingPayments.reduce((sum, p) => sum + p.amount, 0);
    const ownerDebt = ownerMembership.balance < 0 ? Math.abs(ownerMembership.balance) : totalDebt;

    if (unidentifiedPayment.amount > ownerDebt) {
      throw new Error('No se puede asociar: el importe del pago es mayor a la deuda del propietario (no hay saldo a favor aún)');
    }

    if (unidentifiedPayment.amount < ownerDebt) {
      throw new Error('No se puede asociar: el importe del pago es menor a la deuda total del propietario (no se aceptan pagos parciales aún)');
    }

    const payment = new Payment({
      organization: unidentifiedPayment.organization,
      owner: ownerId,
      membership: ownerMembership._id,
      month: period || null,
      amount: unidentifiedPayment.amount,
      status: 'approved',
      paymentMethod: 'manual',
      type: period ? 'monthly' : 'balance',
      units: unitId ? [unitId] : [],
      unidentifiedPaymentId: unidentifiedPayment._id,
      createdBy: userId,
      approvedBy: userId,
    });

    await payment.save();

    unidentifiedPayment.status = 'associated';
    unidentifiedPayment.matchedOwnerId = ownerId;
    unidentifiedPayment.matchedUnitId = unitId || null;
    unidentifiedPayment.matchedPeriods = period ? [period] : [];
    unidentifiedPayment.associatedPaymentId = payment._id;
    unidentifiedPayment.associatedBy = userId;
    unidentifiedPayment.associatedAt = new Date();
    await unidentifiedPayment.save();

    await UnidentifiedPaymentEvent.create({
      organization: unidentifiedPayment.organization,
      unidentifiedPayment: unidentifiedPayment._id,
      eventType: 'associated',
      userId,
      metadata: {
        ownerId,
        unitId,
        period,
        amountApplied: unidentifiedPayment.amount,
        paymentId: payment._id,
      },
    });

    return unidentifiedPayment;
  } catch (error) {
    logger.error('associateUnidentifiedPayment error:', error.message);
    throw error;
  }
}

async function rejectUnidentifiedPayment(id, reason, userId) {
  try {
    const unidentifiedPayment = await UnidentifiedPayment.findOne({
      _id: id,
      isDeleted: false,
    });

    if (!unidentifiedPayment) {
      throw new Error('No se encontró el pago no identificado');
    }

    if (unidentifiedPayment.status !== 'pending') {
      throw new Error('Solo se pueden rechazar pagos en estado pendiente');
    }

    unidentifiedPayment.status = 'rejected';
    unidentifiedPayment.rejectedBy = userId;
    unidentifiedPayment.rejectedAt = new Date();
    unidentifiedPayment.rejectionReason = reason || '';
    await unidentifiedPayment.save();

    await UnidentifiedPaymentEvent.create({
      organization: unidentifiedPayment.organization,
      unidentifiedPayment: unidentifiedPayment._id,
      eventType: 'rejected',
      userId,
      metadata: { reason },
    });

    return unidentifiedPayment;
  } catch (error) {
    logger.error('rejectUnidentifiedPayment error:', error.message);
    throw error;
  }
}

async function archiveUnidentifiedPayment(id, reason, userId) {
  try {
    const unidentifiedPayment = await UnidentifiedPayment.findOne({
      _id: id,
      isDeleted: false,
    });

    if (!unidentifiedPayment) {
      throw new Error('No se encontró el pago no identificado');
    }

    if (!['pending', 'rejected'].includes(unidentifiedPayment.status)) {
      throw new Error('Solo se pueden archivar pagos en estado pendiente o rechazado');
    }

    unidentifiedPayment.status = 'archived';
    unidentifiedPayment.archivedBy = userId;
    unidentifiedPayment.archivedAt = new Date();
    unidentifiedPayment.archiveReason = reason || '';
    await unidentifiedPayment.save();

    await UnidentifiedPaymentEvent.create({
      organization: unidentifiedPayment.organization,
      unidentifiedPayment: unidentifiedPayment._id,
      eventType: 'archived',
      userId,
      metadata: { reason },
    });

    return unidentifiedPayment;
  } catch (error) {
    logger.error('archiveUnidentifiedPayment error:', error.message);
    throw error;
  }
}

async function softDeleteUnidentifiedPayment(id, userId) {
  try {
    const unidentifiedPayment = await UnidentifiedPayment.findOne({
      _id: id,
      isDeleted: false,
    });

    if (!unidentifiedPayment) {
      throw new Error('No se encontró el pago no identificado');
    }

    if (unidentifiedPayment.status !== 'pending') {
      throw new Error('Solo se pueden eliminar pagos en estado pendiente');
    }

    unidentifiedPayment.isDeleted = true;
    unidentifiedPayment.deletedBy = userId;
    unidentifiedPayment.deletedAt = new Date();
    await unidentifiedPayment.save();

    return unidentifiedPayment;
  } catch (error) {
    logger.error('softDeleteUnidentifiedPayment error:', error.message);
    throw error;
  }
}

async function detectPossibleDuplicate(data, orgId) {
  try {
    const { amount, paymentDate, paymentMethod, reference } = data;

    if (!amount || !paymentDate || !paymentMethod) {
      return { hasDuplicate: false, duplicate: null };
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const query = {
      organization: orgId,
      amount,
      paymentDate: new Date(paymentDate),
      paymentMethod,
      isDeleted: false,
      createdAt: { $gte: sevenDaysAgo },
    };

    const existingPayments = await UnidentifiedPayment.find(query);

    for (const payment of existingPayments) {
      const exactMatch =
        payment.amount === amount &&
        payment.paymentDate.getTime() === new Date(paymentDate).getTime() &&
        payment.paymentMethod === paymentMethod;

      if (exactMatch) {
        return {
          hasDuplicate: true,
          duplicate: {
            _id: payment._id,
            amount: payment.amount,
            paymentDate: payment.paymentDate,
            paymentMethod: payment.paymentMethod,
            reference: payment.reference,
            senderName: payment.senderName,
            status: payment.status,
          },
        };
      }

      if (reference && payment.reference) {
        const refNormalized = reference.toLowerCase().trim();
        const paymentRefNormalized = payment.reference.toLowerCase().trim();
        const partialMatch =
          payment.amount === amount &&
          payment.paymentMethod === paymentMethod &&
          (refNormalized.includes(paymentRefNormalized) || paymentRefNormalized.includes(refNormalized));

        if (partialMatch) {
          return {
            hasDuplicate: true,
            duplicate: {
              _id: payment._id,
              amount: payment.amount,
              paymentDate: payment.paymentDate,
              paymentMethod: payment.paymentMethod,
              reference: payment.reference,
              senderName: payment.senderName,
              status: payment.status,
            },
          };
        }
      }
    }

    return { hasDuplicate: false, duplicate: null };
  } catch (error) {
    logger.error('detectPossibleDuplicate error:', error.message);
    throw error;
  }
}

module.exports = {
  createUnidentifiedPayment,
  updateUnidentifiedPayment,
  getUnidentifiedPayments,
  getUnidentifiedPaymentById,
  findPaymentMatchSuggestions,
  associateUnidentifiedPayment,
  rejectUnidentifiedPayment,
  archiveUnidentifiedPayment,
  softDeleteUnidentifiedPayment,
  detectPossibleDuplicate,
  parseStatementFile,
  validateRow,
  checkBulkDuplicates,
  bulkCreateStatements,
};