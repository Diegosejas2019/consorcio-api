const router   = require('express').Router();
const { body, query } = require('express-validator');
const ctrl     = require('../controllers/supportTicketController');
const { protect, restrictTo, requireOrg } = require('../middleware/auth');
const validate = require('../middleware/validate');
const {
  SUPPORT_TICKET_TYPES,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_TICKET_PRIORITIES,
} = require('../models/SupportTicket');

router.use(protect);

const createValidators = [
  body('type').isIn(SUPPORT_TICKET_TYPES).withMessage('Selecciona un tipo de reporte valido.'),
  body('title')
    .trim()
    .isLength({ min: 3, max: 150 })
    .withMessage('El titulo debe tener entre 3 y 150 caracteres.'),
  body('description')
    .trim()
    .isLength({ min: 10, max: 3000 })
    .withMessage('La descripcion debe tener entre 10 y 3000 caracteres.'),
  body('context').optional().isObject().withMessage('El contexto enviado no es valido.'),
];

const listValidators = [
  query('organizationId').optional().isMongoId().withMessage('La organizacion no es valida.'),
  query('status').optional().isIn(SUPPORT_TICKET_STATUSES).withMessage('El estado no es valido.'),
  query('type').optional().isIn(SUPPORT_TICKET_TYPES).withMessage('El tipo no es valido.'),
  query('priority').optional().isIn(SUPPORT_TICKET_PRIORITIES).withMessage('La prioridad no es valida.'),
  query('search').optional().trim().isLength({ max: 100 }).withMessage('La busqueda no puede superar 100 caracteres.'),
];

const updateValidators = [
  body('status').optional().isIn(SUPPORT_TICKET_STATUSES).withMessage('El estado no es valido.'),
  body('priority').optional().isIn(SUPPORT_TICKET_PRIORITIES).withMessage('La prioridad no es valida.'),
  body('adminResponse')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 3000 })
    .withMessage('La respuesta no puede superar 3000 caracteres.'),
  body()
    .custom((value) => ['status', 'priority', 'adminResponse'].some((field) => value[field] !== undefined))
    .withMessage('Debes enviar al menos un campo para actualizar.'),
];

router.post('/', requireOrg, createValidators, validate, ctrl.createTicket);
router.get('/', restrictTo('superadmin'), listValidators, validate, ctrl.getTickets);
router.get('/my', requireOrg, ctrl.getMyTickets);
router.patch('/:id', restrictTo('superadmin'), updateValidators, validate, ctrl.updateTicket);
router.delete('/:id', restrictTo('superadmin'), ctrl.deleteTicket);

module.exports = router;
