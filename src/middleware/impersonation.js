exports.blockOnImpersonation = (req, res, next) => {
  if (req.impersonation?.active) {
    return res.status(403).json({
      success: false,
      message: 'Esta acción no está disponible en modo soporte.',
    });
  }
  next();
};

exports.blockOrgChangeOnImpersonation = (req, res, next) => {
  if (req.impersonation?.active) {
    return res.status(403).json({
      success: false,
      message: 'No podés cambiar de organización durante el modo soporte.',
    });
  }
  next();
};
