const logger = require('../config/logger');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const sendEmail = async ({ to, subject, html }) => {
  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'GestionAr', email: process.env.EMAIL_FROM || 'gestionar.app.info@gmail.com' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(`Brevo error ${res.status}: ${errBody}`);
    logger.error(`Error enviando email a ${to}: ${err.message}`);
    throw err;
  }

  const data = await res.json();
  logger.info(`Email enviado: ${subject} → ${to} [${data.messageId}]`);
  return data;
};

// ── Template base HTML ────────────────────────────────────────
const baseTemplate = (content) => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GestionAr</title>
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #f8f9fb; margin: 0; padding: 0; color: #111827; }
    .wrapper { max-width: 580px; margin: 32px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    .header { background: #1a1a2e; padding: 28px 32px; }
    .header h1 { color: #fff; margin: 0; font-size: 22px; letter-spacing: -0.5px; }
    .header span { color: #a5b4fc; font-size: 13px; }
    .body { padding: 32px; }
    .body p { line-height: 1.7; color: #374151; margin: 0 0 14px; }
    .highlight { background: #eef2ff; border-left: 4px solid #4f46e5; padding: 16px 20px; border-radius: 0 8px 8px 0; margin: 20px 0; }
    .highlight p { margin: 0; color: #3730a3; font-weight: 600; }
    .badge-success { display:inline-block; background:#d1fae5; color:#065f46; padding:6px 14px; border-radius:99px; font-size:13px; font-weight:700; }
    .badge-danger  { display:inline-block; background:#fee2e2; color:#991b1b; padding:6px 14px; border-radius:99px; font-size:13px; font-weight:700; }
    .btn { display:inline-block; background:#4f46e5; color:#fff; padding:13px 28px; border-radius:8px; text-decoration:none; font-weight:700; font-size:15px; margin-top:8px; }
    .footer { background: #f8f9fb; padding: 20px 32px; text-align:center; }
    .footer p { color: #9ca3af; font-size: 12px; margin: 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>🏘️ GestionAr</h1>
      <span>Administración de Barrio Privado</span>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      <p>Este mensaje fue enviado automáticamente. Por favor no respondas este email.</p>
      <p>© 2025 GestionAr — Todos los derechos reservados.</p>
    </div>
  </div>
</body>
</html>`;

// ── Templates específicos ─────────────────────────────────────

exports.sendPaymentApproved = async (owner, payment) => {
  const html = baseTemplate(`
    <p>Hola <strong>${owner.name}</strong>,</p>
    <p>Te informamos que tu comprobante de pago fue <span class="badge-success">✓ Aprobado</span></p>
    <div class="highlight">
      <p>Período: ${payment.monthFormatted}</p>
      <p>Importe: $${payment.amount.toLocaleString('es-AR')}</p>
      <p>Fecha de aprobación: ${new Date(payment.reviewedAt).toLocaleDateString('es-AR')}</p>
    </div>
    <p>Tu cuenta ha sido actualizada. Podés verificar tu estado en la aplicación.</p>
    <p>¡Muchas gracias!</p>
  `);
  return sendEmail({
    to:      owner.email,
    subject: `✓ Pago aprobado — ${payment.monthFormatted} | GestionAr`,
    html,
  });
};

exports.sendPaymentRejected = async (owner, payment, reason) => {
  const html = baseTemplate(`
    <p>Hola <strong>${owner.name}</strong>,</p>
    <p>Lamentablemente tu comprobante de pago fue <span class="badge-danger">✕ Rechazado</span></p>
    <div class="highlight">
      <p>Período: ${payment.monthFormatted}</p>
      <p>Motivo: ${reason}</p>
    </div>
    <p>Por favor revisá el comprobante y volvé a enviarlo desde la aplicación corrigiendo el inconveniente indicado.</p>
    <p>Si tenés dudas, contactá al administrador.</p>
  `);
  return sendEmail({
    to:      owner.email,
    subject: `Comprobante rechazado — ${payment.monthFormatted} | GestionAr`,
    html,
  });
};

exports.sendWelcome = async (owner, tempPassword) => {
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="dark light">
  <meta name="supported-color-schemes" content="dark light">
  <title>¡Bienvenido/a a GestionAr!</title>
  <style>
    body { margin:0 !important; padding:0 !important; width:100% !important; }
    table { border-collapse: collapse !important; }
    img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
    a { text-decoration: none; }
    .btn-primary:hover { background-color:#7de05b !important; }
    @media only screen and (max-width: 620px) {
      .wrap { width: 100% !important; }
      .px-32 { padding-left: 24px !important; padding-right: 24px !important; }
      .py-40 { padding-top: 32px !important; padding-bottom: 32px !important; }
      .h1 { font-size: 26px !important; line-height: 32px !important; }
      .btn-td a { display: block !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#0e1512; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#eef1ed;">

  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#0e1512; opacity:0;">
    Tu cuenta en GestionAr fue creada correctamente. Aquí están tus credenciales de acceso.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0e1512;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" class="wrap" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px; max-width:560px;">

          <!-- LOGO -->
          <tr>
            <td align="left" class="px-32" style="padding: 8px 32px 24px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="padding-right:10px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" width="28" height="28" style="width:28px; height:28px; background-color:#9cf27b; border-radius:8px; color:#0e1512; font-family:'Inter Tight', Arial, sans-serif; font-size:15px; font-weight:700; line-height:28px;">G</td>
                      </tr>
                    </table>
                  </td>
                  <td valign="middle" style="font-family:'Inter Tight', Arial, sans-serif; font-size:20px; font-weight:700; letter-spacing:-0.5px; color:#eef1ed;">
                    Gestion<span style="color:#9cf27b;">Ar</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN CARD -->
          <tr>
            <td align="left" class="px-32 py-40" style="background-color:#18221d; border:1px solid rgba(255,255,255,0.08); border-radius:20px; padding: 44px 40px;">

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
                <tr>
                  <td style="background-color:rgba(156,242,123,0.12); border-radius:999px; padding:6px 12px; font-family:'Courier New', monospace; font-size:11px; font-weight:500; color:#9cf27b; letter-spacing:0.5px;">
                    <span style="color:#9cf27b;">●</span>&nbsp;&nbsp;NUEVA CUENTA
                  </td>
                </tr>
              </table>

              <h1 class="h1" style="margin:0 0 16px 0; font-family:'Inter Tight', Arial, sans-serif; font-size:32px; line-height:38px; font-weight:600; letter-spacing:-0.8px; color:#eef1ed;">
                ¡Bienvenido/a a <span style="color:#9cf27b; font-style:italic; font-weight:500;">GestionAr</span>!
              </h1>

              <p style="margin:0 0 16px 0; font-family:'Inter', Arial, sans-serif; font-size:16px; line-height:24px; color:#eef1ed;">
                Hola <strong style="color:#eef1ed;">${owner.name}</strong>,
              </p>

              <p style="margin:0 0 24px 0; font-family:'Inter', Arial, sans-serif; font-size:15px; line-height:24px; color:#a8b3ac;">
                Tu cuenta fue creada correctamente. Usá las credenciales a continuación para ingresar por primera vez:
              </p>

              <!-- CREDENTIALS -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
                <tr>
                  <td style="background-color:#0e1512; border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:20px 22px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding-bottom:14px; border-bottom:1px solid rgba(255,255,255,0.06);">
                          <div style="font-family:'Courier New', monospace; font-size:10px; color:#6b7870; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;">EMAIL</div>
                          <div style="font-family:'Inter Tight', Arial, sans-serif; font-size:15px; font-weight:500; color:#eef1ed;">${owner.email}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top:14px; padding-bottom:14px; border-bottom:1px solid rgba(255,255,255,0.06);">
                          <div style="font-family:'Courier New', monospace; font-size:10px; color:#6b7870; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;">CONTRASEÑA TEMPORAL</div>
                          <div style="font-family:'Courier New', monospace; font-size:18px; font-weight:700; color:#9cf27b; letter-spacing:2px;">${tempPassword}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-top:14px;">
                          <div style="font-family:'Courier New', monospace; font-size:10px; color:#6b7870; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;">UNIDAD</div>
                          <div style="font-family:'Inter Tight', Arial, sans-serif; font-size:15px; font-weight:500; color:#eef1ed;">${owner.unit || '—'}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px 0;">
                <tr>
                  <td class="btn-td" align="center" bgcolor="#9cf27b" style="background-color:#9cf27b; border-radius:999px; mso-padding-alt:0;">
                    <!--[if mso]>
                      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${process.env.APP_BASE_URL}" style="height:48px; v-text-anchor:middle; width:240px;" arcsize="50%" stroke="f" fillcolor="#9cf27b">
                        <w:anchorlock/>
                        <center style="color:#0e1512; font-family:Arial, sans-serif; font-size:15px; font-weight:600;">Ingresar a GestionAr →</center>
                      </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-- -->
                    <a href="${process.env.APP_BASE_URL}" class="btn-primary" target="_blank" style="display:inline-block; background-color:#9cf27b; color:#0e1512; font-family:'Inter Tight', Arial, sans-serif; font-size:15px; font-weight:600; line-height:48px; text-align:center; text-decoration:none; padding:0 32px; border-radius:999px; letter-spacing:-0.2px;">
                      Ingresar a GestionAr&nbsp;&nbsp;→
                    </a>
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;">
                <tr>
                  <td style="border-top:1px solid rgba(255,255,255,0.08); font-size:0; line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <p style="margin:0; font-family:'Inter', Arial, sans-serif; font-size:14px; line-height:22px; color:#a8b3ac;">
                Te recomendamos cambiar tu contraseña al ingresar por primera vez. Si tenés problemas, contactá al administrador.
              </p>

            </td>
          </tr>

          <!-- TIP -->
          <tr>
            <td class="px-32" style="padding: 24px 32px 0 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#131b17; border:1px solid rgba(255,255,255,0.06); border-radius:16px; padding:20px 22px;">
                    <p style="margin:0 0 10px 0; font-family:'Courier New', monospace; font-size:11px; color:#9cf27b; text-transform:uppercase; letter-spacing:1px; font-weight:500;">
                      CONSEJO DE SEGURIDAD
                    </p>
                    <p style="margin:0; font-family:'Inter', Arial, sans-serif; font-size:13px; line-height:20px; color:#a8b3ac;">
                      GestionAr nunca te va a pedir tu contraseña por email, teléfono o WhatsApp. Si algo te hace dudar, escribinos a <a href="mailto:${process.env.EMAIL_FROM || 'gestionar.app.info@gmail.com'}" style="color:#9cf27b; text-decoration:none;">${process.env.EMAIL_FROM || 'gestionar.app.info@gmail.com'}</a>.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td class="px-32" style="padding: 32px 32px 16px 32px;" align="center">
              <p style="margin:0 0 8px 0; font-family:'Inter', Arial, sans-serif; font-size:12px; line-height:18px; color:#6b7870; text-align:center;">
                Este mensaje fue enviado automáticamente. Por favor no respondas a este email.
              </p>
              <p style="margin:0; font-family:'Courier New', monospace; font-size:11px; line-height:18px; color:#6b7870; text-align:center; letter-spacing:0.5px;">
                © 2026 GESTIONAR — ADMINISTRACIÓN DE BARRIOS PRIVADOS
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
  return sendEmail({
    to:      owner.email,
    subject: '¡Bienvenido/a a GestionAr! Tu acceso está listo.',
    html,
  });
};

exports.sendPasswordReset = async (user, resetUrl) => {
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="dark light">
  <meta name="supported-color-schemes" content="dark light">
  <title>Restablecé tu contraseña · GestionAr</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body { margin:0 !important; padding:0 !important; width:100% !important; }
    table { border-collapse: collapse !important; }
    img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
    a { text-decoration: none; }
    .btn-primary:hover { background-color:#7de05b !important; }
    @media only screen and (max-width: 620px) {
      .wrap { width: 100% !important; }
      .px-32 { padding-left: 24px !important; padding-right: 24px !important; }
      .py-40 { padding-top: 32px !important; padding-bottom: 32px !important; }
      .h1 { font-size: 26px !important; line-height: 32px !important; }
      .btn-td a { display: block !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#0e1512; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#eef1ed;">

  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#0e1512; opacity:0;">
    Creá una nueva contraseña para tu cuenta de GestionAr. El enlace expira en 10 minutos.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0e1512;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" class="wrap" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px; max-width:560px;">

          <!-- LOGO -->
          <tr>
            <td align="left" class="px-32" style="padding: 8px 32px 24px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="padding-right:10px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" width="28" height="28" style="width:28px; height:28px; background-color:#9cf27b; border-radius:8px; color:#0e1512; font-family:'Inter Tight', Arial, sans-serif; font-size:15px; font-weight:700; line-height:28px;">G</td>
                      </tr>
                    </table>
                  </td>
                  <td valign="middle" style="font-family:'Inter Tight', Arial, sans-serif; font-size:20px; font-weight:700; letter-spacing:-0.5px; color:#eef1ed;">
                    Gestion<span style="color:#9cf27b;">Ar</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN CARD -->
          <tr>
            <td align="left" class="px-32 py-40" style="background-color:#18221d; border:1px solid rgba(255,255,255,0.08); border-radius:20px; padding: 44px 40px;">

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
                <tr>
                  <td style="background-color:rgba(156,242,123,0.12); border-radius:999px; padding:6px 12px; font-family:'Courier New', monospace; font-size:11px; font-weight:500; color:#9cf27b; letter-spacing:0.5px;">
                    <span style="color:#9cf27b;">●</span>&nbsp;&nbsp;SEGURIDAD DE CUENTA
                  </td>
                </tr>
              </table>

              <h1 class="h1" style="margin:0 0 16px 0; font-family:'Inter Tight', Arial, sans-serif; font-size:32px; line-height:38px; font-weight:600; letter-spacing:-0.8px; color:#eef1ed;">
                Restablecé tu <span style="color:#9cf27b; font-style:italic; font-weight:500;">contraseña</span>
              </h1>

              <p style="margin:0 0 16px 0; font-family:'Inter', Arial, sans-serif; font-size:16px; line-height:24px; color:#eef1ed;">
                Hola <strong style="color:#eef1ed;">${user.name}</strong>,
              </p>

              <p style="margin:0 0 12px 0; font-family:'Inter', Arial, sans-serif; font-size:15px; line-height:24px; color:#a8b3ac;">
                Recibimos una solicitud para restablecer la contraseña de tu cuenta en GestionAr. Tocá el botón para crear una nueva:
              </p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
                <tr>
                  <td style="background-color:#0e1512; border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:16px 18px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="32" valign="middle" style="padding-right:12px;">
                          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td align="center" width="32" height="32" style="width:32px; height:32px; background-color:rgba(156,242,123,0.12); border-radius:8px; color:#9cf27b; font-family:'Inter Tight', Arial, sans-serif; font-size:14px; font-weight:600; line-height:32px;">⏱</td>
                            </tr>
                          </table>
                        </td>
                        <td valign="middle">
                          <div style="font-family:'Courier New', monospace; font-size:10px; color:#6b7870; text-transform:uppercase; letter-spacing:1px; margin-bottom:2px;">ENLACE VÁLIDO POR</div>
                          <div style="font-family:'Inter Tight', Arial, sans-serif; font-size:15px; font-weight:600; color:#eef1ed;">10 minutos</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px 0;">
                <tr>
                  <td class="btn-td" align="center" bgcolor="#9cf27b" style="background-color:#9cf27b; border-radius:999px; mso-padding-alt:0;">
                    <!--[if mso]>
                      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${resetUrl}" style="height:48px; v-text-anchor:middle; width:260px;" arcsize="50%" stroke="f" fillcolor="#9cf27b">
                        <w:anchorlock/>
                        <center style="color:#0e1512; font-family:Arial, sans-serif; font-size:15px; font-weight:600;">Restablecer contraseña →</center>
                      </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-- -->
                    <a href="${resetUrl}" class="btn-primary" target="_blank" style="display:inline-block; background-color:#9cf27b; color:#0e1512; font-family:'Inter Tight', Arial, sans-serif; font-size:15px; font-weight:600; line-height:48px; text-align:center; text-decoration:none; padding:0 32px; border-radius:999px; letter-spacing:-0.2px;">
                      Restablecer contraseña&nbsp;&nbsp;→
                    </a>
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;">
                <tr>
                  <td style="border-top:1px solid rgba(255,255,255,0.08); font-size:0; line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <p style="margin:0 0 18px 0; font-family:'Inter', Arial, sans-serif; font-size:14px; line-height:22px; color:#a8b3ac;">
                Si no solicitaste este cambio, podés ignorar este email con tranquilidad — tu contraseña no será modificada.
              </p>

              <p style="margin:0 0 8px 0; font-family:'Courier New', monospace; font-size:11px; line-height:16px; color:#6b7870; text-transform:uppercase; letter-spacing:1px;">
                ¿El botón no funciona?
              </p>
              <p style="margin:0; font-family:'Inter', Arial, sans-serif; font-size:13px; line-height:20px; color:#a8b3ac;">
                Copiá y pegá este enlace en tu navegador:<br>
                <a href="${resetUrl}" target="_blank" style="color:#9cf27b; text-decoration:none; word-break:break-all;">${resetUrl}</a>
              </p>

            </td>
          </tr>

          <!-- SECURITY TIP -->
          <tr>
            <td class="px-32" style="padding: 24px 32px 0 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#131b17; border:1px solid rgba(255,255,255,0.06); border-radius:16px; padding:20px 22px;">
                    <p style="margin:0 0 10px 0; font-family:'Courier New', monospace; font-size:11px; color:#9cf27b; text-transform:uppercase; letter-spacing:1px; font-weight:500;">
                      CONSEJO DE SEGURIDAD
                    </p>
                    <p style="margin:0; font-family:'Inter', Arial, sans-serif; font-size:13px; line-height:20px; color:#a8b3ac;">
                      GestionAr nunca te va a pedir tu contraseña por email, teléfono o WhatsApp. Si algo te hace dudar, escribinos a <a href="mailto:${process.env.EMAIL_FROM || 'gestionar.app.info@gmail.com'}" style="color:#9cf27b; text-decoration:none;">${process.env.EMAIL_FROM || 'gestionar.app.info@gmail.com'}</a>.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td class="px-32" style="padding: 32px 32px 16px 32px;" align="center">
              <p style="margin:0 0 8px 0; font-family:'Inter', Arial, sans-serif; font-size:12px; line-height:18px; color:#6b7870; text-align:center;">
                Este mensaje fue enviado automáticamente. Por favor no respondas a este email.
              </p>
              <p style="margin:0; font-family:'Courier New', monospace; font-size:11px; line-height:18px; color:#6b7870; text-align:center; letter-spacing:0.5px;">
                © 2026 GESTIONAR — ADMINISTRACIÓN DE BARRIOS PRIVADOS
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
  return sendEmail({
    to:      user.email,
    subject: 'Restablecé tu contraseña — GestionAr',
    html,
  });
};

exports.sendReceiptEmail = async (owner, payment, receiptUrl) => {
  const html = baseTemplate(`
    <p>Hola <strong>${owner.name}</strong>,</p>
    <p>Tu pago fue <span class="badge-success">✓ Acreditado</span> y tu recibo ya está disponible.</p>
    <div class="highlight">
      <p>Recibo N°: ${payment.receiptNumber}</p>
      <p>Período: ${payment.monthFormatted}</p>
      <p>Importe: $${payment.amount.toLocaleString('es-AR')}</p>
      <p>Fecha de emisión: ${new Date(payment.receiptIssuedAt).toLocaleDateString('es-AR')}</p>
    </div>
    <p>Podés descargar tu recibo desde el siguiente enlace:</p>
    <a href="${receiptUrl}" class="btn" target="_blank">Descargar recibo</a>
    <p style="margin-top:20px; font-size:13px; color:#6b7280;">Si el botón no funciona, copiá este enlace en tu navegador:<br>${receiptUrl}</p>
  `);
  return sendEmail({
    to:      owner.email,
    subject: `Recibo de pago — ${payment.monthFormatted} | GestionAr`,
    html,
  });
};

exports.sendMonthlyReminder = async (owner, expenseMonth, amount, dueDay) => {
  const html = baseTemplate(`
    <p>Hola <strong>${owner.name}</strong>,</p>
    <p>Te recordamos que las expensas del período <strong>${expenseMonth}</strong> vencen el día <strong>${dueDay}</strong>.</p>
    <div class="highlight">
      <p>Período: ${expenseMonth}</p>
      <p>Importe: $${amount.toLocaleString('es-AR')}</p>
      <p>Vencimiento: día ${dueDay} del mes en curso</p>
    </div>
    <p>Podés abonar fácilmente desde la aplicación subiendo tu comprobante o pagando online con MercadoPago.</p>
    <a href="${process.env.APP_BASE_URL}" class="btn">Pagar ahora</a>
  `);
  return sendEmail({
    to:      owner.email,
    subject: `Recordatorio: Expensas ${expenseMonth} vencen el día ${dueDay}`,
    html,
  });
};

exports.sendNoticeEmail = async (owner, notice) => {
  const tagLabels = { info: 'INFORMATIVO', warning: 'ADVERTENCIA', urgent: 'URGENTE' };
  const tagColors = { info: '#9cf27b', warning: '#fbbf24', urgent: '#f87171' };
  const tagBg     = { info: 'rgba(156,242,123,0.12)', warning: 'rgba(251,191,36,0.12)', urgent: 'rgba(248,113,113,0.12)' };
  const tagIcons  = { info: '📢', warning: '⚠️', urgent: '🚨' };

  const color = tagColors[notice.tag] || tagColors.info;
  const bg    = tagBg[notice.tag]     || tagBg.info;
  const label = tagLabels[notice.tag] || notice.tag.toUpperCase();
  const icon  = tagIcons[notice.tag]  || '📢';

  const sentDate = new Date(notice.createdAt).toLocaleDateString('es-AR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const bodyHtml = notice.body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>${notice.title} · GestionAr</title>
  <style>
    body { margin:0 !important; padding:0 !important; width:100% !important; }
    table { border-collapse: collapse !important; }
    img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
    @media only screen and (max-width: 620px) {
      .wrap { width: 100% !important; }
      .px-32 { padding-left: 20px !important; padding-right: 20px !important; }
      .py-40 { padding-top: 28px !important; padding-bottom: 28px !important; }
      .h1 { font-size: 22px !important; line-height: 28px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#0e1512; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#eef1ed;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0e1512;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" class="wrap" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px; max-width:560px;">

          <!-- LOGO -->
          <tr>
            <td align="left" class="px-32" style="padding: 8px 32px 24px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle" style="padding-right:10px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" width="28" height="28" style="width:28px; height:28px; background-color:#9cf27b; border-radius:8px; color:#0e1512; font-family:'Inter Tight', Arial, sans-serif; font-size:15px; font-weight:700; line-height:28px;">G</td>
                      </tr>
                    </table>
                  </td>
                  <td valign="middle" style="font-family:'Inter Tight', Arial, sans-serif; font-size:20px; font-weight:700; letter-spacing:-0.5px; color:#eef1ed;">
                    Gestion<span style="color:#9cf27b;">Ar</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN CARD -->
          <tr>
            <td align="left" class="px-32 py-40" style="background-color:#18221d; border:1px solid rgba(255,255,255,0.08); border-radius:20px; padding: 36px 40px;">

              <!-- TAG BADGE -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
                <tr>
                  <td style="background-color:${bg}; border-radius:999px; padding:5px 12px; font-family:'Courier New', monospace; font-size:11px; font-weight:500; color:${color}; letter-spacing:0.5px;">
                    ${icon}&nbsp;&nbsp;${label}
                  </td>
                </tr>
              </table>

              <!-- TITLE -->
              <h1 class="h1" style="margin:0 0 20px 0; font-family:'Inter Tight', Arial, sans-serif; font-size:26px; line-height:32px; font-weight:700; letter-spacing:-0.6px; color:#eef1ed;">
                ${notice.title}
              </h1>

              <!-- META -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:20px;">
                <tr>
                  <td style="font-family:'Inter', Arial, sans-serif; font-size:13px; color:#6b7870;">
                    <span style="color:#a8b3ac;">De:</span> Administración &nbsp;·&nbsp; <span style="color:#a8b3ac;">Fecha:</span> ${sentDate}
                  </td>
                </tr>
              </table>

              <!-- BODY -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:'Inter', Arial, sans-serif; font-size:15px; line-height:26px; color:#c8d6c8;">
                    ${bodyHtml}
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
                <tr>
                  <td align="center" bgcolor="#9cf27b" style="background-color:#9cf27b; border-radius:999px;">
                    <a href="${process.env.APP_BASE_URL}" target="_blank" style="display:inline-block; background-color:#9cf27b; color:#0e1512; font-family:'Inter Tight', Arial, sans-serif; font-size:14px; font-weight:600; line-height:44px; text-align:center; text-decoration:none; padding:0 28px; border-radius:999px;">
                      Ver en la aplicación&nbsp;&nbsp;→
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td class="px-32" style="padding: 28px 32px 16px 32px;" align="center">
              <p style="margin:0 0 6px 0; font-family:'Inter', Arial, sans-serif; font-size:12px; line-height:18px; color:#6b7870; text-align:center;">
                Este mensaje fue enviado automáticamente. Por favor no respondas a este email.
              </p>
              <p style="margin:0; font-family:'Courier New', monospace; font-size:11px; line-height:18px; color:#6b7870; text-align:center; letter-spacing:0.5px;">
                © 2026 GESTIONAR — ADMINISTRACIÓN DE BARRIOS PRIVADOS
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendEmail({
    to:      owner.email,
    subject: `${icon} ${notice.title} | GestionAr`,
    html,
  });
};

module.exports = { ...exports, sendEmail };
