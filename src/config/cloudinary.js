const cloudinary        = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer            = require('multer');

// Configurar Cloudinary con variables de entorno
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);

const MIME_TO_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg':      'jpg',
  'image/png':       'png',
  'image/webp':      'webp',
  'image/heic':      'heic',
};

// Storage de Cloudinary para multer
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isImage = file.mimetype.startsWith('image/');
    const ext     = MIME_TO_EXT[file.mimetype] || 'bin';
    return {
      folder:          'consorcio/comprobantes',
      resource_type:   isImage ? 'image' : 'raw',
      allowed_formats: isImage ? ['jpg', 'jpeg', 'png', 'webp', 'heic'] : ['pdf'],
      // raw requiere extensión en public_id; image no (Cloudinary la maneja)
      public_id:       isImage
        ? `pago_${req.user?.id}_${Date.now()}`
        : `pago_${req.user?.id}_${Date.now()}.${ext}`,
      type:            'upload',
    };
  },
});

// Filtro de tipos de archivo
const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIMETYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten PDF o imágenes (JPG, PNG, WebP, HEIC).'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

module.exports = { upload, cloudinary };
