const KNOWN_FEATURES = [
  'visits',
  'reservations',
  'votes',
  'claims',
  'notices',
  'expenses',
  'providers',
];

const DEFAULT_DISABLED_FEATURES = new Set(['visits', 'reservations']);

function buildDefaultFeatureMap(records = []) {
  const features = {};
  KNOWN_FEATURES.forEach((key) => {
    features[key] = !DEFAULT_DISABLED_FEATURES.has(key);
  });
  records.forEach((record) => {
    if (KNOWN_FEATURES.includes(record.featureKey)) {
      features[record.featureKey] = record.enabled;
    }
  });
  return features;
}

function defaultFeatureRecords(organizationId) {
  return KNOWN_FEATURES.map((featureKey) => ({
    organization: organizationId,
    featureKey,
    enabled: !DEFAULT_DISABLED_FEATURES.has(featureKey),
  }));
}

module.exports = {
  KNOWN_FEATURES,
  buildDefaultFeatureMap,
  defaultFeatureRecords,
};
