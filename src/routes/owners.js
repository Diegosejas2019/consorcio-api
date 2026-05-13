const router    = require('express').Router();
const multer    = require('multer');
const ctrl      = require('../controllers/ownerController');
const debtCtrl  = require('../controllers/ownerDebtItemController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      || file.originalname.endsWith('.xlsx');
    if (ok) cb(null, true);
    else cb(new Error('Solo se permiten archivos Excel (.xlsx).'), false);
  },
});

// Todas las rutas requieren auth
router.use(protect);

router.get('/stats',       restrictTo('admin'), ctrl.getStats);
router.get('/check-email', restrictTo('admin'), ctrl.checkEmail);
router.get('/',      restrictTo('admin'), ctrl.getAllOwners);
router.post('/',     restrictTo('admin'), ctrl.createOwner);
router.get('/bulk/template', restrictTo('admin'), ctrl.downloadBulkTemplate);
router.post('/bulk',          restrictTo('admin'), excelUpload.single('file'), ctrl.bulkCreateOwners);

router.get('/me/summary', restrictTo('owner'), requireOrg, ctrl.getMySummary);
router.get('/:id/available-items', restrictTo('admin'), ctrl.getOwnerAvailableItems);
router.get('/:id',       ctrl.getOwner);       // admin: cualquiera | owner: solo el suyo (verificado en ctrl)
router.patch('/:id',     restrictTo('admin'), ctrl.updateOwner);
router.delete('/:id',    restrictTo('admin'), ctrl.deleteOwner);
router.post('/:id/notify',      restrictTo('admin'), ctrl.notifyOwner);
router.post('/:id/debt-items',  restrictTo('admin'), debtCtrl.createDebtItem);
router.get('/:id/debt-items',   restrictTo('admin'), debtCtrl.getDebtItemsByOwner);

module.exports = router;
