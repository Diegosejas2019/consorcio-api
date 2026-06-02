const router = require('express').Router();
const { protect, requireOrg, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeature } = require('../middleware/features');
const { blockOnImpersonation } = require('../middleware/impersonation');

const settingCtrl     = require('../controllers/payrollSettingController');
const profileCtrl     = require('../controllers/employeePayrollProfileController');
const ruleCtrl        = require('../controllers/payrollRuleVersionController');
const liquidationCtrl = require('../controllers/payrollLiquidationController');

// Todos los endpoints de payroll requieren autenticación admin con requireOrg
router.use(protect, requireOrg, restrictTo('admin'));

// ── PayrollSetting ────────────────────────────────────────────
router.get('/settings',  requirePermission('payroll.read'), settingCtrl.getSettings);
router.put('/settings',  blockOnImpersonation, requirePermission('payroll.update'), settingCtrl.upsertSettings);

// ── Employee Payroll Profiles ─────────────────────────────────
router.get('/employee-profiles',     requirePermission('payroll.read'), profileCtrl.getProfiles);
router.post('/employee-profiles',    blockOnImpersonation, requirePermission('payroll.create'), profileCtrl.createProfile);
router.get('/employee-profiles/:id', requirePermission('payroll.read'), profileCtrl.getProfile);
router.patch('/employee-profiles/:id', blockOnImpersonation, requirePermission('payroll.update'), profileCtrl.updateProfile);
router.patch('/employee-profiles/:id/deactivate', blockOnImpersonation, requirePermission('payroll.update'), profileCtrl.deactivateProfile);

// ── Payroll Rule Versions (superadmin) ────────────────────────
// Nota: también accesible por superadmin sin requireOrg (ver handler separado abajo)
router.get('/rules', requirePermission('payroll.read'), ruleCtrl.listVersions);
router.get('/rules/:version', requirePermission('payroll.read'), ruleCtrl.getVersion);

// ── Payroll Liquidations ──────────────────────────────────────
// Los endpoints de liquidaciones requieren además el feature flag legalPayroll
const liquidationMiddleware = [requireFeature('legalPayroll'), requirePermission('payroll.read')];

router.get('/liquidations',     liquidationMiddleware, liquidationCtrl.getLiquidations);
router.post('/liquidations',    requireFeature('legalPayroll'), blockOnImpersonation, requirePermission('payroll.create'), liquidationCtrl.createDraft);
router.get('/liquidations/:id', liquidationMiddleware, liquidationCtrl.getLiquidation);
router.delete('/liquidations/:id', requireFeature('legalPayroll'), blockOnImpersonation, requirePermission('payroll.delete'), liquidationCtrl.cancel);

router.post('/liquidations/:id/items',              requireFeature('legalPayroll'), blockOnImpersonation, requirePermission('payroll.update'), liquidationCtrl.addItem);
router.delete('/liquidations/:id/items/:itemIndex', requireFeature('legalPayroll'), blockOnImpersonation, requirePermission('payroll.update'), liquidationCtrl.deleteItem);
router.post('/liquidations/:id/calculate',          requireFeature('legalPayroll'), blockOnImpersonation, requirePermission('payroll.update'), liquidationCtrl.calculate);
router.post('/liquidations/:id/approve',            requireFeature('legalPayroll'), blockOnImpersonation, requirePermission('payroll.approve'), liquidationCtrl.approve);
router.post('/liquidations/:id/mark-paid',          requireFeature('legalPayroll'), blockOnImpersonation, requirePermission('payroll.approve'), liquidationCtrl.markPaid);
router.post('/liquidations/:id/import-advances',    requireFeature('legalPayroll'), blockOnImpersonation, requirePermission('payroll.update'), liquidationCtrl.importAdvances);
router.post('/liquidations/:id/receipt-pdf',        requireFeature('legalPayroll'), blockOnImpersonation, requirePermission('payroll.receipt'), liquidationCtrl.generateReceipt);

// ── Payroll Rule Versions — create (superadmin only) ─────────
// Se maneja en superAdmin routes, pero exponemos aquí para completitud con guard
router.post('/rules', blockOnImpersonation, requirePermission('payroll.create'), ruleCtrl.createVersion);

module.exports = router;
