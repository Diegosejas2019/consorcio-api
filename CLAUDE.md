# ConsorcioPro API

API REST para la gestión de consorcios en barrios privados. Backend de una app mobile (Flutter) que permite a propietarios pagar expensas, recibir avisos y al administrador gestionar todo el consorcio.

## Stack

- **Runtime:** Node.js ≥ 18
- **Framework:** Express 4
- **Base de datos:** MongoDB + Mongoose
- **Autenticación:** JWT (Bearer token, 7d de expiración)
- **Almacenamiento de archivos:** Cloudinary (comprobantes de pago)
- **Pagos:** MercadoPago (preferencias + webhook)
- **Push notifications:** Firebase Admin SDK (FCM)
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
    emailService.js     # envío de emails
    firebaseService.js  # push notifications FCM
```

## Modelos

### User
Roles: `owner` | `admin`. Solo `admin` puede registrar nuevos usuarios.
Campos clave: `unit` (lote/casa), `balance` (negativo = deuda), `isDebtor`, `fcmToken` (push).
Password hasheado con bcrypt (12 rounds), nunca se devuelve en queries.

### Payment
Estados: `pending` → `approved` | `rejected`. Solo el admin aprueba/rechaza.
Canales: `manual` (sube comprobante) | `mercadopago`.
Restricción: un solo pago activo (pending/approved) por propietario por mes.
Comprobante guardado en Cloudinary con `url` + `publicId`.

### Notice
Avisos del consorcio. Tags: `info` | `warning` | `urgent`.
Al crear, el admin puede disparar push notification a todos los propietarios.

### Config
Documento singleton global. Contiene: monto de expensa, mes vigente, % recargo, día de vencimiento, datos del consorcio, credenciales de MercadoPago.
Acceder siempre con `Config.getConfig()`.

## Endpoints

| Método | Ruta | Acceso |
|--------|------|--------|
| POST | `/api/auth/login` | público |
| POST | `/api/auth/register` | admin |
| GET | `/api/auth/me` | autenticado |
| PATCH | `/api/auth/update-password` | autenticado |
| PATCH | `/api/auth/fcm-token` | autenticado |
| GET | `/api/owners` | admin |
| GET | `/api/owners/stats` | admin |
| POST | `/api/owners` | admin |
| GET/PATCH/DELETE | `/api/owners/:id` | admin (o propio owner) |
| GET | `/api/payments` | autenticado (owner: los suyos) |
| POST | `/api/payments` | autenticado (sube comprobante) |
| GET | `/api/payments/dashboard` | admin |
| PATCH | `/api/payments/:id/approve` | admin |
| PATCH | `/api/payments/:id/reject` | admin |
| GET | `/api/notices` | autenticado |
| POST/PATCH/DELETE | `/api/notices` | admin |
| GET/PATCH | `/api/config` | admin |
| POST | `/api/mercadopago/preference` | autenticado |
| POST | `/api/mercadopago/webhook` | público (MP) |
| GET | `/health` | público |

## Autenticación y roles

- `protect` — verifica JWT, que el usuario exista, esté activo y el password no haya cambiado post-token
- `restrictTo('admin')` — solo admin puede acceder
- `ownDataOnly` — owner solo accede a sus propios datos; admin puede todo

## Variables de entorno

Ver `.env.example`. Las críticas:

```
MONGODB_URI
JWT_SECRET
CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
MP_ACCESS_TOKEN / MP_PUBLIC_KEY / MP_WEBHOOK_SECRET
FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
ALLOWED_ORIGINS
```

## Flujo de trabajo

- Después de cada cambio terminado, hacer commit y push al repositorio (`git add`, `git commit`, `git push`).

## Convenciones

- Respuestas siempre con `{ success: true/false, data/message }`
- Fechas en ISO 8601, período de pago en formato `YYYY-MM` (ej: `"2025-04"`)
- Logging con Winston: `logger.info/warn/error/debug`
- Rate limiting global: 200 req/15min; login: 10 intentos/15min por IP
- El webhook de MercadoPago recibe el body en `raw` (configurado en `app.js`)
- `mpPublicKey`, `mpAccessToken`, `mpWebhookSecret` en Config tienen `select: false`
- `fcmToken` y `password` en User tienen `select: false`
