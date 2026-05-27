const OrganizationMember       = require('../models/OrganizationMember');
const Payment                   = require('../models/Payment');
const Claim                     = require('../models/Claim');
const UnidentifiedPayment       = require('../models/UnidentifiedPayment');
const OrganizationAccessRequest = require('../models/OrganizationAccessRequest');
const MonthlyRendition          = require('../models/MonthlyRendition');

exports.getMultiOrgSummary = async (req, res) => {
  try {
    const memberships = await OrganizationMember.find({
      user:     req.user._id,
      role:     'admin',
      isActive: true,
    }).populate('organization', 'name dueDayOfMonth feePeriodCode feePeriodLabel isActive');

    const active = memberships.filter(m => m.organization?.isActive !== false);
    if (!active.length) return res.json({ success: true, data: [] });

    const orgIds = active.map(m => m.organization._id);

    const [paymentsAgg, membersAgg, claimsAgg, unidentAgg, accessAgg, renditions] = await Promise.all([
      Payment.aggregate([
        { $match: { organization: { $in: orgIds } } },
        { $group: {
          _id:    { organization: '$organization', status: '$status', month: { $ifNull: ['$month', null] } },
          count:  { $sum: 1 },
          amount: { $sum: '$amount' },
        }},
      ]),
      OrganizationMember.aggregate([
        { $match: { organization: { $in: orgIds }, role: 'owner', isActive: true } },
        { $group: {
          _id:          '$organization',
          ownersCount:  { $sum: 1 },
          debtorsCount: { $sum: { $cond: ['$isDebtor', 1, 0] } },
        }},
      ]),
      Claim.aggregate([
        { $match: { organization: { $in: orgIds }, status: { $in: ['open', 'in_progress'] } } },
        { $group: { _id: '$organization', count: { $sum: 1 } } },
      ]),
      UnidentifiedPayment.aggregate([
        { $match: { organization: { $in: orgIds }, status: 'pending', isDeleted: { $ne: true } } },
        { $group: { _id: '$organization', count: { $sum: 1 } } },
      ]),
      OrganizationAccessRequest.aggregate([
        { $match: { organization: { $in: orgIds }, status: 'pending' } },
        { $group: { _id: '$organization', count: { $sum: 1 } } },
      ]),
      MonthlyRendition.find({ organization: { $in: orgIds } }, 'organization period status').lean(),
    ]);

    // Indexar por orgId string
    const paymentsMap = {};
    for (const p of paymentsAgg) {
      const key = p._id.organization.toString();
      if (!paymentsMap[key]) paymentsMap[key] = { pending: 0, approvedByMonth: {} };
      if (p._id.status === 'pending') {
        paymentsMap[key].pending += p.count;
      } else if (p._id.status === 'approved' && p._id.month) {
        paymentsMap[key].approvedByMonth[p._id.month] =
          (paymentsMap[key].approvedByMonth[p._id.month] || 0) + p.amount;
      }
    }

    const membersMap  = Object.fromEntries(membersAgg.map(m => [m._id.toString(), m]));
    const claimsMap   = Object.fromEntries(claimsAgg.map(c => [c._id.toString(), c.count]));
    const unidentMap  = Object.fromEntries(unidentAgg.map(u => [u._id.toString(), u.count]));
    const accessMap   = Object.fromEntries(accessAgg.map(a => [a._id.toString(), a.count]));

    const renditionMap = {};
    for (const r of renditions) {
      const key = r.organization.toString();
      if (!renditionMap[key]) renditionMap[key] = {};
      renditionMap[key][r.period] = r.status;
    }

    const data = active.map(m => {
      const orgId      = m.organization._id.toString();
      const period     = m.organization.feePeriodCode || '';
      const payData    = paymentsMap[orgId] || { pending: 0, approvedByMonth: {} };
      const memberData = membersMap[orgId]  || { ownersCount: 0, debtorsCount: 0 };

      const ownersCount   = memberData.ownersCount  || 0;
      const debtorsCount  = memberData.debtorsCount || 0;
      const pendingCount  = payData.pending;
      const approvedAmt   = payData.approvedByMonth[period] || 0;
      const unidentCount  = unidentMap[orgId]  || 0;
      const claimsCount   = claimsMap[orgId]   || 0;
      const accessCount   = accessMap[orgId]   || 0;
      const rendStatus    = renditionMap[orgId]?.[period] || null;

      let alertLevel = 'normal';
      if (
        (ownersCount > 0 && debtorsCount / ownersCount >= 0.3) ||
        claimsCount >= 10 ||
        accessCount >= 5
      ) {
        alertLevel = 'critical';
      } else if (debtorsCount > 0 || claimsCount > 0 || unidentCount > 0 || accessCount > 0) {
        alertLevel = 'warning';
      }

      return {
        organizationId:                      m.organization._id,
        organizationName:                    m.organization.name,
        membershipId:                        m._id,
        period,
        periodLabel:                         m.organization.feePeriodLabel || period,
        dueDayOfMonth:                       m.organization.dueDayOfMonth,
        ownersCount,
        debtorsCount,
        pendingPaymentsCount:                pendingCount,
        approvedPaymentsAmountCurrentPeriod: approvedAmt,
        pendingUnidentifiedPaymentsCount:    unidentCount,
        openClaimsCount:                     claimsCount,
        pendingAccessRequestsCount:          accessCount,
        currentRenditionStatus:              rendStatus,
        alertLevel,
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al obtener el resumen de organizaciones.' });
  }
};
