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

const providerStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isImage = file.mimetype.startsWith('image/');
    const ext     = MIME_TO_EXT[file.mimetype] || 'bin';
    return {
      folder:          'consorcio/proveedores',
      resource_type:   isImage ? 'image' : 'raw',
      allowed_formats: isImage ? ['jpg', 'jpeg', 'png', 'webp', 'heic'] : ['pdf'],
      public_id:       isImage
        ? `prov_${Date.now()}`
        : `prov_${Date.now()}.${ext}`,
      type:            'upload',
    };
  },
});

const uploadProvider = multer({
  storage:    providerStorage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

function makeUploader(folder, prefix) {
  const s = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const isImage = file.mimetype.startsWith('image/');
      const ext     = MIME_TO_EXT[file.mimetype] || 'bin';
      return {
        folder,
        resource_type:   isImage ? 'image' : 'raw',
        allowed_formats: isImage ? ['jpg', 'jpeg', 'png', 'webp', 'heic'] : ['pdf'],
        public_id:       isImage
          ? `${prefix}_${req.user?.id}_${Date.now()}`
          : `${prefix}_${req.user?.id}_${Date.now()}.${ext}`,
        type: 'upload',
      };
    },
  });
  return multer({ storage: s, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });
}

const uploadClaim  = makeUploader('consorcio/reclamos', 'claim');
const uploadNotice = makeUploader('consorcio/avisos',   'aviso');
const uploadEmployee = makeUploader('consorcio/empleados', 'emp');

const organizationDocumentStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isImage = file.mimetype.startsWith('image/');
    const ext     = MIME_TO_EXT[file.mimetype] || 'bin';
    return {
      folder:          `gestionar/organization-documents/${req.orgId}`,
      resource_type:   isImage ? 'image' : 'raw',
      allowed_formats: isImage ? ['jpg', 'jpeg', 'png', 'webp'] : ['pdf'],
      public_id:       isImage
        ? `doc_${req.user?.id}_${Date.now()}`
        : `doc_${req.user?.id}_${Date.now()}.${ext}`,
      type:            'upload',
    };
  },
});

const organizationDocumentFileFilter = (req, file, cb) => {
  const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  if (allowed.has(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new Error('Solo se permiten PDF o imagenes JPG, PNG o WebP.');
    err.statusCode = 400;
    cb(err, false);
  }
};

const uploadOrganizationDocument = multer({
  storage: organizationDocumentStorage,
  fileFilter: organizationDocumentFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

async function deleteCloudinaryAttachments(attachments = []) {
  await Promise.all(
    attachments
      .filter(a => a?.publicId)
      .map(a => {
        const resType = a.mimetype?.startsWith('image/') ? 'image' : 'raw';
        return cloudinary.uploader.destroy(a.publicId, { resource_type: resType }).catch(() => {});
      })
  );
}

module.exports = {
  upload,
  uploadProvider,
  uploadClaim,
  uploadNotice,
  uploadEmployee,
  uploadOrganizationDocument,
  deleteCloudinaryAttachments,
  cloudinary,
};
