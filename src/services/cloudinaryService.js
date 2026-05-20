const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function validateCloudinaryConfig() {
  const requiredVars = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ];

  const missingVars = requiredVars.filter((name) => !String(process.env[name] || '').trim());

  if (missingVars.length > 0) {
    const error = new Error(`Faltan variables de Cloudinary: ${missingVars.join(', ')}.`);
    error.statusCode = 500;
    throw error;
  }
}

function uploadBufferToCloudinary(file, options = {}) {
  validateCloudinaryConfig();

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: options.resource_type || 'auto',
        folder:        options.folder,
        public_id:     options.public_id,
        allowed_formats: options.allowed_formats,
        type:          options.type || 'upload',
        overwrite:     options.overwrite,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      }
    );

    uploadStream.end(file.buffer);
  });
}

module.exports = {
  cloudinary,
  uploadBufferToCloudinary,
  validateCloudinaryConfig,
};
