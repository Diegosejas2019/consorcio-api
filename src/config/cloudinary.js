const multer = require('multer');
const { cloudinary, uploadBufferToCloudinary } = require('../services/cloudinaryService');

const MAX_FILE_SIZE = 10 * 1024 * 1024;

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

const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic'];
const DOCUMENT_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];

const memoryStorage = multer.memoryStorage();

function getExtension(file) {
  return MIME_TO_EXT[file.mimetype] || 'bin';
}

function isImage(file) {
  return file.mimetype.startsWith('image/');
}

function fileFilter(req, file, cb) {
  if (ALLOWED_MIMETYPES.has(file.mimetype)) {
    cb(null, true);
    return;
  }

  cb(new Error('Solo se permiten PDF o imagenes (JPG, PNG, WebP, HEIC).'), false);
}

function organizationDocumentFileFilter(req, file, cb) {
  const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

  if (allowed.has(file.mimetype)) {
    cb(null, true);
    return;
  }

  const err = new Error('Solo se permiten PDF o imagenes JPG, PNG o WebP.');
  err.statusCode = 400;
  cb(err, false);
}

function normalizeUploadedFile(file, result) {
  return {
    ...file,
    path:     result.secure_url,
    filename: result.public_id,
  };
}

async function uploadOneFile(req, file, buildParams) {
  const params = await buildParams(req, file);
  const result = await uploadBufferToCloudinary(file, params);
  return normalizeUploadedFile(file, result);
}

function cloudinaryUploadMiddleware(buildParams) {
  return async (req, res, next) => {
    try {
      if (req.file) {
        req.file = await uploadOneFile(req, req.file, buildParams);
      }

      if (Array.isArray(req.files) && req.files.length > 0) {
        const uploadedFiles = [];

        try {
          for (const file of req.files) {
            uploadedFiles.push(await uploadOneFile(req, file, buildParams));
          }
        } catch (error) {
          await Promise.all(
            uploadedFiles
              .filter((file) => file?.filename)
              .map((file) => {
                const resourceType = file.mimetype?.startsWith('image/') ? 'image' : 'raw';
                return cloudinary.uploader.destroy(file.filename, { resource_type: resourceType }).catch(() => {});
              })
          );

          throw error;
        }

        req.files = uploadedFiles;
      }

      if (req.files && !Array.isArray(req.files) && typeof req.files === 'object') {
        const uploadedByField = {};
        const uploadedFiles = [];

        try {
          for (const [fieldName, files] of Object.entries(req.files)) {
            uploadedByField[fieldName] = [];

            for (const file of files) {
              const uploadedFile = await uploadOneFile(req, file, buildParams);
              uploadedByField[fieldName].push(uploadedFile);
              uploadedFiles.push(uploadedFile);
            }
          }
        } catch (error) {
          await Promise.all(
            uploadedFiles
              .filter((file) => file?.filename)
              .map((file) => {
                const resourceType = file.mimetype?.startsWith('image/') ? 'image' : 'raw';
                return cloudinary.uploader.destroy(file.filename, { resource_type: resourceType }).catch(() => {});
              })
          );

          throw error;
        }

        req.files = uploadedByField;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

function createCloudinaryMulter({ buildParams, filter = fileFilter }) {
  const upload = multer({
    storage: memoryStorage,
    fileFilter: filter,
    limits: { fileSize: MAX_FILE_SIZE },
  });

  return {
    single(fieldName) {
      return [upload.single(fieldName), cloudinaryUploadMiddleware(buildParams)];
    },
    array(fieldName, maxCount) {
      return [upload.array(fieldName, maxCount), cloudinaryUploadMiddleware(buildParams)];
    },
    fields(fields) {
      return [upload.fields(fields), cloudinaryUploadMiddleware(buildParams)];
    },
  };
}

function paymentUploadParams(req, file) {
  const image = isImage(file);
  const ext = getExtension(file);

  return {
    // Carpeta fija por compatibilidad con URLs existentes. No cambiar sin estrategia de migración.
    folder:          'consorcio/comprobantes',
    resource_type:   image ? 'image' : 'raw',
    allowed_formats: image ? IMAGE_FORMATS : ['pdf'],
    public_id:       image
      ? `pago_${req.user?.id}_${Date.now()}`
      : `pago_${req.user?.id}_${Date.now()}.${ext}`,
    type:            'upload',
  };
}

function providerUploadParams(req, file) {
  const image = isImage(file);
  const ext = getExtension(file);

  return {
    folder:          'consorcio/proveedores',
    resource_type:   image ? 'image' : 'raw',
    allowed_formats: image ? IMAGE_FORMATS : ['pdf'],
    public_id:       image ? `prov_${Date.now()}` : `prov_${Date.now()}.${ext}`,
    type:            'upload',
  };
}

function makeUploader(folder, prefix) {
  return createCloudinaryMulter({
    buildParams: (req, file) => {
      const image = isImage(file);
      const ext = getExtension(file);

      return {
        folder,
        resource_type:   image ? 'image' : 'raw',
        allowed_formats: image ? IMAGE_FORMATS : ['pdf'],
        public_id:       image
          ? `${prefix}_${req.user?.id}_${Date.now()}`
          : `${prefix}_${req.user?.id}_${Date.now()}.${ext}`,
        type:            'upload',
      };
    },
  });
}

function organizationDocumentUploadParams(req, file) {
  const image = isImage(file);
  const ext = getExtension(file);

  return {
    folder:          `gestionar/organization-documents/${req.orgId}`,
    resource_type:   image ? 'image' : 'raw',
    allowed_formats: image ? DOCUMENT_IMAGE_FORMATS : ['pdf'],
    public_id:       image
      ? `doc_${req.user?.id}_${Date.now()}`
      : `doc_${req.user?.id}_${Date.now()}.${ext}`,
    type:            'upload',
  };
}

const upload = createCloudinaryMulter({ buildParams: paymentUploadParams });
const uploadProvider = createCloudinaryMulter({ buildParams: providerUploadParams });
const uploadClaim = makeUploader('consorcio/reclamos', 'claim');
const uploadNotice = makeUploader('consorcio/avisos', 'aviso');
const uploadEmployee = makeUploader('consorcio/empleados', 'emp');
const uploadOrganizationDocument = createCloudinaryMulter({
  buildParams: organizationDocumentUploadParams,
  filter: organizationDocumentFileFilter,
});

async function deleteCloudinaryAttachments(attachments = []) {
  await Promise.all(
    attachments
      .filter((attachment) => attachment?.publicId)
      .map((attachment) => {
        const resourceType = attachment.mimetype?.startsWith('image/') ? 'image' : 'raw';
        return cloudinary.uploader.destroy(attachment.publicId, { resource_type: resourceType }).catch(() => {});
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
