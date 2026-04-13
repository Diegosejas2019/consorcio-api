process.env.NODE_ENV       = 'test';
process.env.JWT_SECRET     = 'test-secret-32-chars-minimum-ok!';
process.env.JWT_EXPIRES_IN = '1h';

// Servicios externos — deshabilitados en tests
process.env.CLOUDINARY_CLOUD_NAME  = 'test';
process.env.CLOUDINARY_API_KEY     = 'test';
process.env.CLOUDINARY_API_SECRET  = 'test';
process.env.FIREBASE_PROJECT_ID    = '';
process.env.FIREBASE_CLIENT_EMAIL  = '';
process.env.FIREBASE_PRIVATE_KEY   = '';
