const ExpenseCategory = require('../models/ExpenseCategory');

const DEFAULT_EXPENSE_CATEGORIES = [
  { key: 'cleaning',       label: 'Limpieza' },
  { key: 'security',       label: 'Seguridad' },
  { key: 'maintenance',    label: 'Mantenimiento' },
  { key: 'utilities',      label: 'Servicios' },
  { key: 'administration', label: 'Administracion' },
  { key: 'salaries',       label: 'Sueldos' },
  { key: 'other',          label: 'Otros' },
];

function slugifyCategoryKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

async function ensureDefaultExpenseCategories(organizationId, createdBy = null) {
  const ops = DEFAULT_EXPENSE_CATEGORIES.map(category => ({
    updateOne: {
      filter: { organization: organizationId, key: category.key },
      update: {
        $setOnInsert: {
          organization: organizationId,
          key:          category.key,
          label:        category.label,
          isActive:     true,
          createdBy,
        },
      },
      upsert: true,
    },
  }));

  if (ops.length) await ExpenseCategory.bulkWrite(ops, { ordered: false });
}

async function listExpenseCategories(organizationId, options = {}) {
  await ensureDefaultExpenseCategories(organizationId, options.createdBy);
  return ExpenseCategory.find({ organization: organizationId, isActive: { $ne: false } })
    .sort({ label: 1 })
    .lean();
}

async function getExpenseCategoryLabelMap(organizationId) {
  const categories = await listExpenseCategories(organizationId);
  return categories.reduce((map, category) => {
    map[category.key] = category.label;
    return map;
  }, {});
}

async function assertExpenseCategoryExists(organizationId, key) {
  const categoryKey = slugifyCategoryKey(key);
  if (!categoryKey) {
    return { error: { status: 400, message: 'La categoria es obligatoria.' } };
  }

  await ensureDefaultExpenseCategories(organizationId);
  const category = await ExpenseCategory.findOne({
    organization: organizationId,
    key:          categoryKey,
    isActive:     { $ne: false },
  }).lean();

  if (!category) {
    return { error: { status: 400, message: 'Categoria de gasto no valida.' } };
  }

  return { key: categoryKey, category };
}

module.exports = {
  DEFAULT_EXPENSE_CATEGORIES,
  assertExpenseCategoryExists,
  ensureDefaultExpenseCategories,
  getExpenseCategoryLabelMap,
  listExpenseCategories,
  slugifyCategoryKey,
};
