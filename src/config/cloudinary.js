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
  params: async (req) => ({
    folder:          'consorcio/comprobantes',
    resource_type:   'raw',
    allowed_formats: ['pdf'],
    public_id:       `pago_${req.user?.id}_${Date.now()}.pdf`,
    type:            'upload',
  }),
});

// Filtro de tipos de archivo
const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos PDF.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

module.exports = { upload, cloudinary };
