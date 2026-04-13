const Organization = require('../../src/models/Organization');
const User         = require('../../src/models/User');
const { signToken } = require('../../src/middleware/auth');

/**
 * Crea una Organization + User(owner) y devuelve { user, token, orgId }.
 * El password ya está hasheado por el pre-save hook de User.
 */
exports.createOwnerWithToken = async (overrides = {}) => {
  const slug = `test-org-${Date.now()}`;

  const org = await Organization.create({
    name: 'Test Org',
    slug,
    businessType: 'consorcio',
  });

  const user = await User.create({
    name:         overrides.name     ?? 'Test Owner',
    email:        overrides.email    ?? `owner-${Date.now()}@test.com`,
    password:     overrides.password ?? 'password123',
    role:         'owner',
    organization: org._id,
    unit:         'Lote 1',
    isActive:     true,
  });

  const token = signToken(user._id);
  return { user, token, orgId: org._id };
};

/**
 * Crea un User(admin) vinculado a una org existente o nueva.
 */
exports.createAdminWithToken = async (orgId = null) => {
  if (!orgId) {
    const org = await Organization.create({
      name: `Admin Org ${Date.now()}`,
      slug: `admin-org-${Date.now()}`,
      businessType: 'consorcio',
    });
    orgId = org._id;
  }

  const user = await User.create({
    name:         'Test Admin',
    email:        `admin-${Date.now()}@test.com`,
    password:     'password123',
    role:         'admin',
    organization: orgId,
    isActive:     true,
  });

  const token = signToken(user._id);
  return { user, token, orgId };
};
