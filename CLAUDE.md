# GestionAr API

API REST multi-tenant para la gestión de organizaciones (consorcios, gimnasios, colegios, clubes). Permite a miembros pagar cuotas, recibir avisos y gestionar reclamos; y al administrador gestionar toda la organización.

## Stack

- **Runtime:** Node.js >= 18
- **Framework:** Express 4
- **Base de datos:** MongoDB + Mongoose
- **Autenticación:** JWT (Bearer token, 7d de expiración)
- **Almacenamiento de archivos:** Cloudinary (comprobantes: PDF, JPG, PNG, WebP, HEIC)
- **Pagos:** MercadoPago Checkout Pro (preferencias + webhook HMAC)
- **Push notifications:** Firebase Admin SDK (FCM, mensajes data-only)
- **Email:** Brevo (API HTTP)
- **Monitoreo:** Sentry (solo errores 5xx)
- **Deploy:** Railway

## Comandos

```bash
npm run dev     # desarrollo con nodemon
npm start       # producción
npm run seed    # poblar DB con datos iniciales
```

## Estructura

```
server.js               # entry point — conecta DB, inicia scheduler, levanta Express
src/
  app.js                # Express: middlewares, rutas, rate limiting, Sentry
  config/
    db.js               # conexión MongoDB
    cloudinary.js       # configuración + multer storage (10 MB, PDF/imagen)
    logger.js           # Winston (JSON + consola colorizada)
    seed.js             # script de seed (1 org, 1 admin, 5 owners, pagos, avisos)
  controllers/          # lógica de negocio por recurso
  middleware/
    auth.js             # protect, restrictTo, requireOrg, ownDataOnly, signToken
    errorHandler.js     # handler global + 404
    validate.js         # wrapper de express-validator
  models/               # esquemas Mongoose
  routes/               # definición de endpoints (incluye internal.js para rutas internas)
  services/
    emailService.js     # envío de emails (Brevo API HTTP) con templates HTML
    firebaseService.js  # push notifications FCM (sendToUser, sendMulticast)
    schedulerService.js # cron diario 09:00 UTC — recordatorios de vencimiento
```

## Modelos

### Organization
Entidad raíz del sistema multi-tenant. Cada organización tiene su propia configuración, miembros y datos de pago.
- `businessType`: `consorcio` | `gimnasio` | `colegio` | `club` | `other`
- Templates predefinidos con terminología específica (`feeLabel`, `memberLabel`, `unitLabel`)
- Configuración de mora: `lateFeeType` (`percent` | `fixed`), `lateFeePercent`, `lateFeeFixed`
- `dueDayOfMonth`: día de vencimiento (1–28)
- `monthlyFee`: monto mensual base; `feeAmount`: importe alternativo (ambos default 0)
- `feePeriodCode`: período actual de cobro (formato `YYYY-MM`); `feePeriodLabel`: versión legible ("Abril 2025")
- `paymentPeriods`: array de períodos habilitados para pago (formato `YYYY-MM`)
- `bankName`, `bankAccount`, `bankCbu`, `bankHolder`: datos bancarios para transferencia
- `receiptCounter`: contador secuencial de recibos (se incrementa con cada recibo generado)
- `isActive`: soft-disable de la organización
- Credenciales MercadoPago propias con `select: false`: `mpPublicKey`, `mpAccessToken`, `mpWebhookSecret`
- `slug` único (auto-generado desde el nombre)

### User
Roles: `owner` | `admin` | `superadmin`.
Campos clave: `unit` (texto libre), `phone`, `balance` (negativo = deuda), `percentage` (prorrateo 0–100), `isDebtor`, `startBillingPeriod` (YYYY-MM, período a partir del cual se cobran expensas), `fcmToken` (select: false).
Password hasheado con bcrypt (12 rounds), nunca devuelto en queries.
`DELETE /api/owners/:id` es soft-delete: pone `isActive: false`. El propietario deja de aparecer en listados y no puede iniciar sesión, pero su historial de pagos se conserva.
Virtual `initials` (primeras 2 letras de los primeros 2 nombres). Virtual `units` (ref a `Unit`, las unidades asignadas al propietario).

### Payment
Estados: `pending` → `approved` | `rejected`.
Canales: `manual` | `mercadopago`.
`month` (YYYY-MM): opcional — ausente en pagos de solo-extraordinarios.
Restricción: un solo pago activo (`pending` o `approved`) por propietario por mes; índice `{owner, month}` con `sparse: true` para excluir pagos sin `month`.
`extraordinaryItems`: array de `{ expense, amount }` con los conceptos extraordinarios incluidos en el pago.
Comprobante en Cloudinary: `url`, `publicId`, `filename`, `mimetype`, `size`.
Campos MP: `mpPreferenceId`, `mpPaymentId`, `mpStatus`, `mpDetail`.
Virtual `monthFormatted`: "Abril 2025" si tiene `month`, "Extraordinario" si no.

### Notice
Tags: `info` | `warning` | `urgent`.
Al crear, el admin puede disparar push notification a todos los miembros.
Virtual `tagLabel` en español.
Owners pueden marcar avisos como leídos/no leídos (`PATCH /:id/read`, `PATCH /:id/unread`).

### Claim
Categorías: `infrastructure` | `security` | `noise` | `cleaning` | `billing` | `other`.
Estados: `open` → `in_progress` → `resolved`.
Sólo owners pueden crear reclamos. Admin actualiza estado y puede agregar `adminNote`.
Virtuales: `categoryLabel`, `statusLabel` en español.

### Expense
Gastos de la organización. Categorías: `cleaning` | `security` | `maintenance` | `utilities` | `administration` | `other`.
Estados: `pending` | `paid`. Métodos de pago: `cash` | `transfer` | `mercadopago`.
`expenseType`: `ordinary` (default) | `extraordinary` — clasifica el gasto.
`isChargeable` (bool, default `false`): solo relevante en `extraordinary`. Si `true`, el gasto aparece como concepto cobrable que los propietarios pueden incluir al crear un pago.
`appliesToAllOwners` (bool, default `true`): si `false`, solo aplica a propietarios específicos (uso futuro).
`invoiceNumber`: número de factura del gasto (opcional).
`invoiceCuit`: CUIT del proveedor en la factura (opcional; si está vacío, el PDF usa el CUIT del Provider asociado).
Puede tener comprobante adjunto en Cloudinary. Referencia opcional a `Provider`.

**Flujo de gastos extraordinarios cobrables:**
1. Admin crea un `Expense` con `expenseType: 'extraordinary'` e `isChargeable: true`.
2. Al llamar `GET /api/payments` (o al crear un pago), el sistema devuelve los gastos extraordinarios cobrables disponibles (no pagados aún por ese propietario).
3. El propietario crea un pago con `extraordinaryIds: [id1, id2]` (puede ir con o sin `month`). Si no hay `month`, es un pago de solo-extraordinarios.
4. El sistema valida que los gastos existan, sean cobrables, y no estén ya en un pago activo del mismo propietario.

### Provider
Proveedores de servicios de la organización.
Campos: `name`, `serviceType` (mismas categorías que Expense), `cuit`, `phone`, `email`, `active`.
Soft-delete: `active: false`.

### Unit
Unidades funcionales de la organización (lotes, departamentos, membresías, etc.), asignadas a un propietario.
Campos: `organization`, `owner` (ref User), `name`, `coefficient` (default 1, para prorrateo), `customFee` (monto fijo personalizado; prevalece sobre `organization.monthlyFee * coefficient`), `active`.
Índices: `{organization, owner}`, `{organization, active}`.

### Visit
Visitas autorizadas por propietarios para ingreso al complejo.
Tipos (`type`): `visit` | `provider` | `delivery`.
Estados (`status`): `pending` | `approved` | `rejected` | `inside` | `exited`.
Campos: `organization`, `owner`, `name` (del visitante), `type`, `expectedDate`, `note`, `approvedBy`, `approvedAt`.
Virtuales: `typeLabel`, `statusLabel` en español.

### Space
Espacios comunes reservables de la organización.
Campos: `organization`, `name`, `description`, `capacity`, `requiresApproval` (bool, default false).

### Reservation
Reservas de espacios comunes por propietarios.
Campos: `organization`, `owner`, `space` (ref Space), `date` (YYYY-MM-DD), `startTime` (HH:mm), `endTime` (HH:mm), `status` (`pending` | `approved` | `rejected` | `cancelled`), `note`.
Índice compuesto `{organization, space, date}` para consultas de disponibilidad.
Virtual `statusLabel` en español.

### OrganizationFeature
Feature flags por organización. Permite habilitar/deshabilitar módulos (visits, reservations, votes, expenses, providers) de forma independiente.
Campos: `organization`, `featureKey` (string), `enabled` (bool, default true).
Índice único `{organization, featureKey}`.

### Config
Legado — singleton global. Usar `Organization` para configuración por organización.

### Vote
Votaciones creadas por el admin para los propietarios.
Campos: `title`, `description`, `options[]` (label + votes), `status` (`open` | `closed`), `endsAt` (fecha límite opcional), `createdBy`, `closedBy`, `closedAt`, `pushSent`, `pushSentAt`.
Mínimo 2 opciones. Las opciones no se pueden modificar una vez que hay votos registrados.
Virtual: `totalVotes`, `statusLabel`.

### VoteResponse
Registro del voto de cada propietario. Índice único `{ vote, owner }` para garantizar un voto por persona.
Campos: `vote`, `organization`, `owner`, `optionIndex`.

## Endpoints

| Método | Ruta | Acceso |
|--------|------|--------|
| POST | `/api/auth/login` | público |
| POST | `/api/auth/register` | admin |
| GET | `/api/auth/me` | autenticado |
| PATCH | `/api/auth/update-password` | autenticado |
| PATCH | `/api/auth/fcm-token` | autenticado |
| POST | `/api/auth/forgot-password` | público |
| POST | `/api/auth/reset-password/:token` | público |
| GET | `/api/organizations` | admin, superadmin |
| POST | `/api/organizations` | admin, superadmin |
| GET | `/api/organizations/templates` | autenticado |
| GET/PATCH | `/api/organizations/:id` | admin, superadmin |
| DELETE | `/api/organizations/:id` | superadmin |
| GET | `/api/organizations/:id/members` | admin, superadmin |
| GET | `/api/organizations/:id/features` | autenticado |
| PUT | `/api/organizations/:id/features` | admin, superadmin |
| GET | `/api/owners` | admin |
| GET | `/api/owners/stats` | admin |
| POST | `/api/owners` | admin |
| GET | `/api/owners/bulk/template` | admin |
| POST | `/api/owners/bulk` | admin (Excel .xlsx, máx 5 MB) |
| GET/PATCH/DELETE | `/api/owners/:id` | admin (o propio owner) |
| POST | `/api/owners/:id/notify` | admin |
| GET | `/api/units` | autenticado + requireOrg |
| POST | `/api/units` | admin, superadmin |
| PATCH | `/api/units/:id` | admin, superadmin |
| DELETE | `/api/units/:id` | admin, superadmin |
| GET | `/api/payments` | autenticado (owner: los suyos) |
| POST | `/api/payments` | autenticado (con upload comprobante) |
| GET | `/api/payments/dashboard` | admin |
| GET | `/api/payments/:id` | autenticado |
| GET | `/api/payments/:id/receipt` | autenticado |
| DELETE | `/api/payments/:id` | autenticado (owner: solo pending) |
| PATCH | `/api/payments/:id/approve` | admin |
| PATCH | `/api/payments/:id/reject` | admin |
| POST | `/api/payments/send-reminders` | admin |
| POST | `/api/payments/:id/resend-receipt` | admin |
| GET | `/api/notices` | autenticado |
| GET | `/api/notices/:id` | autenticado |
| POST | `/api/notices` | admin |
| PATCH | `/api/notices/:id` | admin |
| DELETE | `/api/notices/:id` | admin |
| PATCH | `/api/notices/:id/read` | autenticado |
| PATCH | `/api/notices/:id/unread` | autenticado |
| GET | `/api/claims` | autenticado (owner: los suyos) |
| POST | `/api/claims` | owner |
| PATCH | `/api/claims/:id/status` | admin |
| DELETE | `/api/claims/:id` | admin |
| GET | `/api/expenses/summary` | autenticado (owner y admin) |
| GET | `/api/expenses` | admin |
| POST | `/api/expenses` | admin (con upload comprobante) |
| PATCH | `/api/expenses/:id` | admin |
| PATCH | `/api/expenses/:id/paid` | admin |
| DELETE | `/api/expenses/:id` | admin |
| GET | `/api/providers` | admin |
| POST | `/api/providers` | admin |
| PATCH | `/api/providers/:id` | admin |
| DELETE | `/api/providers/:id` | admin |
| GET | `/api/visits` | autenticado (owner: las suyas) |
| POST | `/api/visits` | owner |
| PATCH | `/api/visits/:id/status` | admin |
| DELETE | `/api/visits/:id` | autenticado |
| GET | `/api/spaces` | autenticado |
| POST | `/api/spaces` | admin |
| PATCH | `/api/spaces/:id` | admin |
| DELETE | `/api/spaces/:id` | admin |
| GET | `/api/reservations` | autenticado (owner: las suyas) |
| POST | `/api/reservations` | autenticado |
| PATCH | `/api/reservations/:id/status` | admin |
| DELETE | `/api/reservations/:id` | autenticado |
| GET | `/api/reports/monthly-summary` | admin |
| GET | `/api/reports/expensas-pdf` | admin (PDF descargable, `?month=YYYY-MM`) |
| GET/PATCH | `/api/config` | admin |
| GET | `/api/votes` | autenticado |
| POST | `/api/votes` | admin |
| GET | `/api/votes/:id` | autenticado |
| PATCH | `/api/votes/:id` | admin |
| PATCH | `/api/votes/:id/close` | admin |
| DELETE | `/api/votes/:id` | admin |
| POST | `/api/votes/:id/cast` | owner |
| GET | `/api/votes/:id/results` | admin |
| POST | `/api/mercadopago/preference` | autenticado |
| POST | `/api/mercadopago/webhook` | público (MP) |
| GET | `/api/mercadopago/payment/:mpPaymentId` | autenticado |
| GET | `/health` | público |
| POST | `/api/internal/create-organization` | interno (`x-internal-key` header) |

## Autenticación y roles

- `protect` — verifica JWT, existencia del usuario, estado activo y que la contraseña no cambió post-token
- `restrictTo('admin')` — solo admin
- `restrictTo('admin', 'superadmin')` — admin o superadmin
- `requireOrg` — bloquea si el usuario no tiene organización asignada
- `ownDataOnly` — owner solo accede a sus propios datos
- Multi-tenant: queries filtradas automáticamente por `organization` del usuario autenticado

## Servicios

### schedulerService
Cron diario a las 09:00 UTC. Por cada organización cuyo `dueDayOfMonth` coincida con el día actual, envía notificaciones FCM a todos los owners sin pago aprobado en el período vigente (`feePeriodCode`). El endpoint `POST /api/payments/send-reminders` permite disparar esto manualmente.

### emailService
Proveedor: **Brevo** (API HTTP). Variable de entorno: `BREVO_API_KEY`.

Emails enviados y cuándo se disparan:

| Función | Cuándo se envía | Disparado por |
|---------|----------------|---------------|
| `sendWelcome(owner, tempPassword)` | Al crear un propietario (individual o carga masiva) | `POST /api/owners`, `POST /api/owners/bulk` |
| `sendPasswordReset(user, resetUrl)` | Al solicitar recuperación de contraseña (link válido 10 min) | `POST /api/auth/forgot-password` |
| `sendPaymentApproved(owner, payment)` | Al aprobar un pago manualmente o via webhook MP | `PATCH /api/payments/:id/approve`, webhook MP |
| `sendPaymentRejected(owner, payment, reason)` | Al rechazar un pago manualmente o via webhook MP | `PATCH /api/payments/:id/reject`, webhook MP |
| `sendReceiptEmail(owner, payment, receiptUrl)` | Al aprobar un pago (si se genera recibo PDF) o al reenviar el recibo | `PATCH /api/payments/:id/approve`, `POST /api/payments/:id/resend-receipt` |
| `sendMonthlyReminder(owner, month, amount, dueDay)` | Cron diario 09:00 UTC (solo owners sin pago aprobado) o disparo manual | `schedulerService`, `POST /api/payments/send-reminders` |

Los errores de envío se loguean pero **no interrumpen** el flujo principal (`.catch()` silencioso en bienvenida y recordatorios; awaiteado en aprobación/rechazo).

### firebaseService
`sendToUser(userId, {title, body, data})` — busca el FCM token del usuario y envía.
`sendMulticast(tokens[], {title, body, data})` — envío en lotes de 500.
Tokens inválidos se limpian automáticamente. Mensajes data-only para compatibilidad Android 14+.

## Manejo de errores

Todos los mensajes de error al usuario están en español y son amigables (sin jerga técnica).

- `CastError` (ID inválido) → "El identificador proporcionado no es válido."
- Duplicate key 11000 → mensaje específico por campo (email, owner_month)
- `ValidationError` Mongoose → mensajes de los modelos concatenados
- Multer `LIMIT_FILE_SIZE` → "El archivo supera el límite de 10 MB."
- 404 de ruta desconocida → "El recurso solicitado no existe."
- 500 → "Error interno del servidor." (detalle solo en logs)

Formato de respuesta siempre: `{ success: false, message: "..." }`

## Variables de entorno

Ver `.env.example`. Las críticas:

```
MONGODB_URI
JWT_SECRET
JWT_EXPIRES_IN                       # default: 7d
CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
APP_BASE_URL                         # para construir notification_url del webhook MP
FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
BREVO_API_KEY                        # email via Brevo API
ALLOWED_ORIGINS
INTERNAL_API_KEY                     # para el endpoint POST /api/internal/create-organization
SENTRY_DSN                           # opcional
```

Las credenciales de MercadoPago se configuran por organización desde el panel admin,
no en variables de entorno.

## MCPs disponibles

| Servidor | Uso |
|----------|-----|
| **Railway** | Gestión del deploy, variables de entorno, logs de producción |
| **MongoDB** | Acceso directo a la DB Atlas (`clustereden` / `consorcio`) |
| **MercadoPago** | Documentación y sugerencias de integración (`https://mcp.mercadopago.com/mcp`) |
| **Vercel** | (disponible, no usado actualmente) |
| ~~Cloudinary~~ | *(falla al conectar — no usar)* |

## Flujo de trabajo

- Después de cada cambio terminado, hacer commit y push.

## Convenciones

- Respuestas siempre con `{ success: true/false, data/message }`
- Fechas en ISO 8601, período en formato `YYYY-MM`
- Logging con Winston: `logger.info/warn/error/debug`
- Rate limiting: 200 req/15min global; 10 intentos/15min en login; 5 req/hora en forgot-password
- Webhook MP recibe body en `raw`
- `mpPublicKey`, `mpAccessToken`, `mpWebhookSecret` en Organization tienen `select: false`
- `fcmToken` y `password` en User tienen `select: false`
- Mensajes FCM son data-only para compatibilidad Android 14+
- Errores de usuario siempre en español, sin exponer detalles técnicos
