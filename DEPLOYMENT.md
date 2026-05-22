# GestionAr API - Flujo QA y Produccion

## Flujo de ramas

- `main`: produccion. Solo se mergea despues de validar QA.
- `develop`: QA. Todo cambio probado debe integrarse primero aca.
- `feature/<nombre>`: cambios nuevos. Sale desde `develop` y vuelve por PR a `develop`.
- `hotfix/<nombre>`: correcciones urgentes. Sale desde `main`, se prueba en QA si el tiempo lo permite, vuelve a `main` y luego se mergea a `develop`.

Comandos habituales:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/nombre-corto
```

## Ambientes

Produccion:

- Railway: servicio API de produccion.
- MongoDB Atlas: base `consorcio`.
- `NODE_ENV=production`.
- `MONGODB_URI` debe apuntar a `consorcio`.
- `ALLOWED_ORIGINS` solo debe incluir dominios productivos.

QA:

- Railway: servicio API separado para QA.
- MongoDB Atlas: base `gestionar_qa`.
- `NODE_ENV=qa`.
- `MONGODB_URI` debe apuntar a `gestionar_qa`.
- `ALLOWED_ORIGINS` solo debe incluir Preview/QA de Vercel.

El backend bloquea el arranque si `NODE_ENV=production` no usa `consorcio` o si `NODE_ENV=qa/staging` no usa `gestionar_qa`. Seeds y migraciones tambien bloquean escrituras contra `consorcio` salvo confirmacion explicita con `ALLOW_PRODUCTION_DB_WRITE=true`.

## Variables Railway

Configurar por separado en cada servicio Railway:

```text
NODE_ENV
PORT
MONGODB_URI
JWT_SECRET
JWT_EXPIRES_IN
APP_BASE_URL
ALLOWED_ORIGINS
BREVO_API_KEY
EMAIL_FROM
SUPPORT_EMAIL
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
INTERNAL_API_KEY
SENTRY_DSN
```

Usar `.env.production` y `.env.qa` solo como plantillas. No commitear secretos reales ni pegar valores reales en esos archivos.

## Deploy

QA:

1. Mergear PR a `develop`.
2. Railway QA debe desplegar desde `develop` o desde un servicio conectado a esa rama.
3. Verificar `/health` y flujos principales contra `gestionar_qa`.

Produccion:

1. Validar QA.
2. Mergear `develop` hacia `main` por PR.
3. Railway produccion debe desplegar solo desde `main`.
4. Verificar `/health`, login, pagos, reportes y emails.

## Rollback

- Railway: usar rollback/redeploy del servicio productivo al deployment anterior.
- MongoDB: restaurar backup solo con confirmacion explicita y ventana operativa.
- Si el rollback de codigo requiere hotfix, crear `hotfix/<nombre>` desde `main`, mergear a `main` y luego a `develop`.

## Validacion local

```bash
npm test
npm start
```

Nunca correr `npm run seed` o migraciones contra `consorcio` sin confirmacion explicita.
