const router   = require('express').Router();
const { body } = require('express-validator');
const ctrl     = require('../controllers/contactController');
const validate = require('../middleware/validate');

const demoRequestValidators = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Ingresá tu nombre.'),
  body('administration')
    .trim()
    .isLength({ min: 2, max: 150 })
    .withMessage('Ingresá el nombre de la administración.'),
  body('email')
    .trim()
    .isEmail()
    .withMessage('Ingresá un email válido.'),
  body('phone')
    .trim()
    .isLength({ min: 6, max: 40 })
    .withMessage('Ingresá un teléfono válido.'),
  body('consortiaRange')
    .isIn(ctrl.CONTACT_RANGES.consortia)
    .withMessage('Seleccioná la cantidad aproximada de consorcios.'),
  body('unitsRange')
    .isIn(ctrl.CONTACT_RANGES.units)
    .withMessage('Seleccioná la cantidad aproximada de unidades.'),
  body('message')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 2000 })
    .withMessage('El mensaje no puede superar 2000 caracteres.'),
  body('website')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 200 })
    .withMessage('La solicitud no es válida.'),
];

router.post('/demo-request', ctrl.skipHoneypot, demoRequestValidators, validate, ctrl.createDemoRequest);

module.exports = router;
