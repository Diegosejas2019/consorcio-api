require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Payment = require('../models/Payment');
const Claim = require('../models/Claim');
const Visit = require('../models/Visit');
const Reservation = require('../models/Reservation');
const VoteResponse = require('../models/VoteResponse');
const Unit = require('../models/Unit');
const PaymentPlan = require('../models/PaymentPlan');
const OwnerDebtItem = require('../models/OwnerDebtItem');
const SupportTicket = require('../models/SupportTicket');

const referenceModels = [
  ['payments', Payment, 'owner'],
  ['claims', Claim, 'owner'],
  ['visits', Visit, 'owner'],
  ['reservations', Reservation, 'owner'],
  ['voteResponses', VoteResponse, 'owner'],
  ['units', Unit, 'owner'],
  ['paymentPlans', PaymentPlan, 'owner'],
  ['debtItems', OwnerDebtItem, 'owner'],
  ['supportTickets', SupportTicket, 'userId'],
];

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('Falta MONGODB_URI.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const duplicateGroups = await User.aggregate([
    { $match: { isActive: { $ne: false }, email: { $type: 'string', $ne: '' } } },
    { $group: { _id: { $toLower: '$email' }, userIds: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  const report = [];

  for (const group of duplicateGroups) {
    const users = await User.find({ _id: { $in: group.userIds } })
      .select('_id name email role organization isActive createdAt')
      .populate('organization', 'name')
      .lean();

    const memberships = await OrganizationMember.find({ user: { $in: group.userIds } })
      .select('_id user organization role adminRole isActive createdAt')
      .populate('organization', 'name')
      .lean();

    const references = {};
    for (const [name, Model, field] of referenceModels) {
      references[name] = await Model.countDocuments({ [field]: { $in: group.userIds } });
    }

    report.push({
      email: group._id,
      userIds: group.userIds.map(String),
      users: users.map(user => ({
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: user.organization?._id ? String(user.organization._id) : null,
        organizationName: user.organization?.name || null,
        isActive: user.isActive !== false,
        createdAt: user.createdAt,
      })),
      memberships: memberships.map(membership => ({
        id: String(membership._id),
        userId: String(membership.user),
        organizationId: membership.organization?._id ? String(membership.organization._id) : null,
        organizationName: membership.organization?.name || null,
        role: membership.role,
        adminRole: membership.adminRole || null,
        isActive: membership.isActive !== false,
        createdAt: membership.createdAt,
      })),
      references,
    });
  }

  console.log(JSON.stringify({
    dryRun: true,
    generatedAt: new Date().toISOString(),
    duplicateEmailCount: report.length,
    duplicates: report,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(JSON.stringify({
    dryRun: true,
    success: false,
    message: err.message,
  }, null, 2));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
