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
- **Email:** Nodemailer (SMTP)
- **Deploy:** Railway

## Comandos

```bash
npm run dev     # desarrollo con nodemon
npm start       # producción
npm run seed    # poblar DB con datos iniciales
```

## Estructura

```
server.js               # entry point — conecta DB y levanta Express
src/
  app.js                # Express: middlewares, rutas, rate limiting
  config/
    db.js               # conexión MongoDB
    cloudinary.js       # configuración + multer storage
    logger.js           # Winston
    seed.js             # script de seed
  controllers/          # lógica de negocio por recurso
  middleware/
    auth.js             # protect, restrictTo, ownDataOnly, signToken
    errorHandler.js     # handler global + 404
    validate.js         # wrapper de express-validator
  models/               # esquemas Mongoose
  routes/               # definición de endpoints
  services/
    emailService.js     # envío de emails (Nodemailer SMTP)
    firebaseService.js  # push notifications FCM
```

## Modelos

### Organization
Entidad raíz del sistema multi-tenant. Cada organización tiene su propia configuración, miembros y datos de pago.
- `businessType`: `consorcio` | `gimnasio` | `colegio` | `club` | `other`
- Templates predefinidos con terminología específica (`feeLabel`, `memberLabel`, `unitLabel`)
- Credenciales MercadoPago propias con `select: false`
- `slug` único (auto-generado desde el nombre)

### User
Roles: `owner` | `admin` | `superadmin`.
Campos clave: `unit`, `balance` (negativo = deuda), `isDebtor`, `fcmToken`.
Password hasheado con bcrypt (12 rounds), nunca devuelto en queries.

### Payment
Estados: `pending` → `approved` | `rejected`.
Canales: `manual` | `mercadopago`.
Restricción: un solo pago activo por propietario por mes.
Comprobante en Cloudinary: `url` + `publicId`.

### Notice
Tags: `info` | `warning` | `urgent`.
Al crear, el admin puede disparar push notification a todos los miembros.

### Claim
Categorías: `infrastructure` | `security` | `noise` | `cleaning` | `billing` | `other`.
Estados: `open` → `in_progress` → `resolved`.

### Config
Legado — singleton global. Usar `Organization` para configuración por organización.

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
| GET | `/api/owners` | admin |
| GET | `/api/owners/stats` | admin |
| POST | `/api/owners` | admin |
| GET/PATCH/DELETE | `/api/owners/:id` | admin (o propio owner) |
| GET | `/api/payments` | autenticado (owner: los suyos) |
| POST | `/api/payments` | autenticado |
| GET | `/api/payments/dashboard` | admin |
| PATCH | `/api/payments/:id/approve` | admin |
| PATCH | `/api/payments/:id/reject` | admin |
| GET | `/api/notices` | autenticado |
| POST/PATCH/DELETE | `/api/notices` | admin |
| GET | `/api/claims` | autenticado (owner: los suyos) |
| POST | `/api/claims` | autenticado |
| PATCH | `/api/claims/:id/status` | admin |
| DELETE | `/api/claims/:id` | admin |
| GET/PATCH | `/api/config` | admin |
| POST | `/api/mercadopago/preference` | autenticado |
| POST | `/api/mercadopago/webhook` | público (MP) |
| GET | `/health` | público |

## Autenticación y roles

- `protect` — verifica JWT, existencia, estado activo y no cambio de password post-token
- `restrictTo('admin')` — solo admin
- `restrictTo('admin', 'superadmin')` — admin o superadmin
- `ownDataOnly` — owner solo accede a sus propios datos
- Multi-tenant: queries filtradas automáticamente por `organization` del usuario autenticado

## Variables de entorno

Ver `.env.example`. Las críticas:

```
MONGODB_URI
JWT_SECRET
CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
APP_BASE_URL                         # para construir notification_url del webhook MP
FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
ALLOWED_ORIGINS
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
- Rate limiting: 200 req/15min global; 10 intentos/15min en login
- Webhook MP recibe body en `raw`
- `mpPublicKey`, `mpAccessToken`, `mpWebhookSecret` en Organization tienen `select: false`
- `fcmToken` y `password` en User tienen `select: false`
- Mensajes FCM son data-only para compatibilidad Android 14+
