require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { v2: cloudinary } = require('cloudinary');
const { assertMongoEnvironment } = require('../config/environmentGuard');

const BACKUPS_TO_KEEP = 8;
const BACKUP_PREFIX = 'gestionar-backup';
const BACKUP_PATTERN = /^gestionar-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.gz$/;
const projectRoot = path.join(__dirname, '../..');
const forceLocalBackup = process.argv.includes('--local');

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0');

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join('-');
}

function sanitizeOutput(output) {
  let sanitized = output || '';
  const secrets = [
    process.env.MONGO_URI,
    process.env.CLOUDINARY_API_KEY,
    process.env.CLOUDINARY_API_SECRET
  ].filter(Boolean);

  secrets.forEach((secret) => {
    sanitized = sanitized.split(secret).join('[SECRETO]');
  });

  return sanitized.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[MONGO_URI]');
}

function resolveBackupDir() {
  const configuredDir = process.env.BACKUP_DIR || 'backups';

  if (path.isAbsolute(configuredDir)) {
    return configuredDir;
  }

  return path.join(projectRoot, configuredDir);
}

function getStorageProvider() {
  if (forceLocalBackup) {
    return 'none';
  }

  return (process.env.BACKUP_STORAGE_PROVIDER || 'none').trim().toLowerCase();
}

function shouldKeepLocalBackup() {
  return ['true', '1', 'yes', 'si'].includes(
    String(process.env.KEEP_LOCAL_BACKUP || '').trim().toLowerCase()
  );
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`El comando termino con codigo ${code}.`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function ensureMongodumpAvailable() {
  try {
    await runCommand('mongodump', ['--version']);
  } catch (error) {
    throw new Error(
      'No se encontro mongodump. Instala MongoDB Database Tools y verifica que mongodump este disponible en el PATH.'
    );
  }
}

function validateStorageProvider(provider) {
  const supportedProviders = ['none', 'cloudinary'];

  if (!supportedProviders.includes(provider)) {
    throw new Error(
      `BACKUP_STORAGE_PROVIDER invalido: ${provider}. Valores permitidos: none, cloudinary.`
    );
  }

  if (provider !== 'cloudinary') {
    return;
  }

  const requiredVars = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'CLOUDINARY_BACKUP_FOLDER'
  ];

  const missingVars = requiredVars.filter((name) => !String(process.env[name] || '').trim());

  if (missingVars.length > 0) {
    throw new Error(
      `Faltan variables para subir backups a Cloudinary: ${missingVars.join(', ')}.`
    );
  }
}

async function rotateBackups(backupDir) {
  const entries = await fs.readdir(backupDir, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isFile() && BACKUP_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const backupsToDelete = backups.slice(BACKUPS_TO_KEEP);

  await Promise.all(
    backupsToDelete.map((filename) => fs.unlink(path.join(backupDir, filename)))
  );

  return backupsToDelete.length;
}

async function uploadToCloudinary(backupPath, filename) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });

  const publicId = filename.replace(/\.gz$/, '');

  console.log('Subida a Cloudinary iniciada.');

  const result = await cloudinary.uploader.upload(backupPath, {
    resource_type: 'raw',
    folder: process.env.CLOUDINARY_BACKUP_FOLDER,
    public_id: publicId,
    use_filename: true,
    unique_filename: false,
    overwrite: true
  });

  console.log(`Subida a Cloudinary exitosa: ${result.public_id}`);
  return result;
}

async function handleStorage({ provider, backupPath, backupDir, filename }) {
  if (provider === 'none') {
    const deletedCount = await rotateBackups(backupDir);
    console.log(`Rotacion local aplicada. Backups eliminados: ${deletedCount}.`);
    return;
  }

  await uploadToCloudinary(backupPath, filename);

  if (shouldKeepLocalBackup()) {
    const deletedCount = await rotateBackups(backupDir);
    console.log(`Archivo local conservado. Rotacion local aplicada. Backups eliminados: ${deletedCount}.`);
    return;
  }

  await fs.rm(backupPath, { force: true });
  console.log('Archivo local temporal eliminado despues de la subida externa.');
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  const backupDir = resolveBackupDir();
  const provider = getStorageProvider();

  if (!mongoUri) {
    throw new Error('Falta la variable de entorno MONGO_URI. No se genero ningun backup.');
  }

  assertMongoEnvironment({ uri: mongoUri, variableName: 'MONGO_URI', operation: 'read-script' });
  validateStorageProvider(provider);
  await ensureMongodumpAvailable();
  await fs.mkdir(backupDir, { recursive: true });

  const filename = `${BACKUP_PREFIX}-${formatDate(new Date())}.gz`;
  const backupPath = path.join(backupDir, filename);

  console.log(`Iniciando backup MongoDB: ${filename}`);
  console.log(`Proveedor de almacenamiento: ${provider}.`);

  let dumpCompleted = false;

  try {
    await runCommand('mongodump', ['--uri', mongoUri, `--archive=${backupPath}`, '--gzip']);
    dumpCompleted = true;
    console.log(`Archivo generado correctamente en: ${backupPath}`);

    await handleStorage({ provider, backupPath, backupDir, filename });
    console.log('Backup finalizado correctamente.');
  } catch (error) {
    if (!dumpCompleted) {
      await fs.rm(backupPath, { force: true }).catch(() => {});
    }

    const details = sanitizeOutput([error.message, error.stderr].filter(Boolean).join('\n'));
    const localBackupMessage = dumpCompleted
      ? `\nEl archivo local se conserva en: ${backupPath}`
      : '';

    throw new Error(`No se pudo completar el backup.\n${details}${localBackupMessage}`);
  }
}

main().catch((error) => {
  console.error(sanitizeOutput(error.message));
  process.exit(1);
});
