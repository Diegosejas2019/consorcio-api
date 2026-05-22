const NoticeTemplate = require('../models/NoticeTemplate');

function filterBody(body = {}) {
  const data = {};
  ['title', 'subject', 'body', 'category'].forEach(key => {
    if (body[key] !== undefined) data[key] = String(body[key]).trim();
  });
  return data;
}

exports.getTemplates = async (req, res, next) => {
  try {
    const { category, search } = req.query;
    const filter = { organization: req.orgId, isActive: true, deletedAt: { $exists: false } };
    if (category) filter.category = category;
    if (search) {
      const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: re }, { subject: re }, { body: re }];
    }
    const templates = await NoticeTemplate.find(filter)
      .populate('createdBy updatedBy', 'name')
      .sort({ updatedAt: -1, createdAt: -1 })
      .select('-__v');
    res.json({ success: true, data: { templates } });
  } catch (err) {
    next(err);
  }
};

exports.createTemplate = async (req, res, next) => {
  try {
    const template = await NoticeTemplate.create({
      ...filterBody(req.body),
      organization: req.orgId,
      createdBy: req.user._id,
    });
    await template.populate('createdBy', 'name');
    res.status(201).json({ success: true, data: { template } });
  } catch (err) {
    next(err);
  }
};

exports.updateTemplate = async (req, res, next) => {
  try {
    const template = await NoticeTemplate.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId, isActive: true, deletedAt: { $exists: false } },
      { $set: { ...filterBody(req.body), updatedBy: req.user._id } },
      { new: true, runValidators: true }
    ).populate('createdBy updatedBy', 'name');
    if (!template) return res.status(404).json({ success: false, message: 'Plantilla no encontrada.' });
    res.json({ success: true, data: { template } });
  } catch (err) {
    next(err);
  }
};

exports.deleteTemplate = async (req, res, next) => {
  try {
    const template = await NoticeTemplate.findOneAndUpdate(
      { _id: req.params.id, organization: req.orgId, isActive: true, deletedAt: { $exists: false } },
      { $set: { isActive: false, deletedAt: new Date(), updatedBy: req.user._id } },
      { new: true }
    );
    if (!template) return res.status(404).json({ success: false, message: 'Plantilla no encontrada.' });
    res.json({ success: true, message: 'Plantilla eliminada.' });
  } catch (err) {
    next(err);
  }
};
