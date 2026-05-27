const {
  KNOWN_FEATURES,
  buildDefaultFeatureMap,
  defaultFeatureRecords,
} = require('../src/utils/features');

describe('feature catalog contract', () => {
  test('mantiene el catalogo canonico de modulos configurables', () => {
    expect(KNOWN_FEATURES).toEqual([
      'visits',
      'reservations',
      'votes',
      'claims',
      'notices',
      'expenses',
      'providers',
      'documents',
    ]);
  });

  test('defaults respetan modulos deshabilitados por defecto', () => {
    expect(buildDefaultFeatureMap()).toEqual({
      visits: false,
      reservations: false,
      votes: true,
      claims: true,
      notices: true,
      expenses: true,
      providers: true,
      documents: true,
    });
  });

  test('defaultFeatureRecords usa el mismo catalogo y organizacion', () => {
    const records = defaultFeatureRecords('org-1');
    expect(records).toHaveLength(KNOWN_FEATURES.length);
    expect(records.map((record) => record.featureKey)).toEqual(KNOWN_FEATURES);
    expect(records.every((record) => record.organization === 'org-1')).toBe(true);
  });
});
