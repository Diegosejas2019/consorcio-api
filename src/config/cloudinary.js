const cloudinary        = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer            = require('multer');

// Configurar Cloudinary con variables de entorno
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Storage de Cloudinary para multer
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isImage = file.mimetype.startsWith('image/');
    return {
      folder:         'consorcio/comprobantes',
      resource_type:  isImage ? 'image' : 'raw',   // raw para PDFs
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
      transformation: isImage
        ? [{ quality: 'auto', fetch_format: 'auto', width: 1200, crop: 'limit' }]
        : undefined,
      public_id: `pago_${req.user?.id}_${Date.now()}`,
    };
  },
});

// Filtro de tipos de archivo
const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no permitido. Solo JPG, PNG, WEBP o PDF.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

module.exports = { upload, cloudinary };
