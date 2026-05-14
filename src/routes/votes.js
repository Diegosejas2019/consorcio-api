const router   = require('express').Router();
const { body } = require('express-validator');
const ctrl     = require('../controllers/voteController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const { requirePermission, requirePermissionForAdmin } = require('../middleware/permissions');
const validate = require('../middleware/validate');

router.use(protect, requireOrg);

// ── Listar y obtener ──────────────────────────────────────────
router.get('/',    requirePermissionForAdmin('votes.read'), ctrl.getVotes);
router.get('/:id', requirePermissionForAdmin('votes.read'), ctrl.getVote);

// ── Crear (admin) ─────────────────────────────────────────────
router.post(
  '/',
  restrictTo('admin'),
  requirePermission('votes.create'),
  [
    body('title')
      .trim()
      .notEmpty()
      .withMessage('El título es obligatorio.')
      .isLength({ max: 150 })
      .withMessage('El título no puede superar 150 caracteres.'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage('La descripción no puede superar 2000 caracteres.'),
    body('options')
      .isArray({ min: 2 })
      .withMessage('Debés proporcionar al menos 2 opciones.')
      .custom((arr) => arr.every((o) => typeof o === 'string' && o.trim().length > 0))
      .withMessage('Cada opción debe ser un texto no vacío.'),
    body('endsAt')
      .optional()
      .isISO8601()
      .withMessage('La fecha de cierre debe ser una fecha válida.')
      .custom((val) => new Date(val) > new Date())
      .withMessage('La fecha de cierre debe ser futura.'),
  ],
  validate,
  ctrl.createVote
);

// ── Editar (admin, solo si abierta) ──────────────────────────
router.patch(
  '/:id',
  restrictTo('admin'),
  requirePermission('votes.update'),
  [
    body('title')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('El título no puede estar vacío.')
      .isLength({ max: 150 })
      .withMessage('El título no puede superar 150 caracteres.'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage('La descripción no puede superar 2000 caracteres.'),
    body('options')
      .optional()
      .isArray({ min: 2 })
      .withMessage('Debés proporcionar al menos 2 opciones.')
      .custom((arr) => arr.every((o) => typeof o === 'string' && o.trim().length > 0))
      .withMessage('Cada opción debe ser un texto no vacío.'),
    body('endsAt')
      .optional()
      .isISO8601()
      .withMessage('La fecha de cierre debe ser una fecha válida.')
      .custom((val) => new Date(val) > new Date())
      .withMessage('La fecha de cierre debe ser futura.'),
  ],
  validate,
  ctrl.updateVote
);

// ── Cerrar votación (admin) ───────────────────────────────────
router.patch('/:id/close', restrictTo('admin'), requirePermission('votes.close'), ctrl.closeVote);

// ── Eliminar (admin) ──────────────────────────────────────────
router.delete('/:id', restrictTo('admin'), requirePermission('votes.delete'), ctrl.deleteVote);

// ── Emitir voto (owner) ───────────────────────────────────────
router.post(
  '/:id/cast',
  restrictTo('owner'),
  [
    body('optionIndex')
      .isInt({ min: 0 })
      .withMessage('Debés seleccionar una opción válida.'),
  ],
  validate,
  ctrl.castVote
);

// ── Resultados detallados (admin) ─────────────────────────────
router.get('/:id/results', restrictTo('admin'), requirePermission('votes.read'), ctrl.getResults);

module.exports = router;
