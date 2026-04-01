const { validationResult } = require('express-validator');

// Middleware: devuelve 400 si express-validator encontró errores
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array().map(e => e.msg).join('. '),
      errors: errors.array(),
    });
  }
  next();
};

module.exports = validate;
