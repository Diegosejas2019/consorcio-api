const fs = require('fs');
const puppeteer = require('puppeteer');

const DEFAULT_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

const SYSTEM_BROWSER_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
];

function fileExists(path) {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return SYSTEM_BROWSER_PATHS.find(fileExists);
}

function isBrowserMissingError(err) {
  const message = String(err?.message || '');
  return (
    message.includes('Could not find Chrome')
    || message.includes('Could not find Chromium')
    || message.includes('Browser was not found')
    || message.includes('Failed to launch the browser process')
    || message.includes('spawn') && message.includes('ENOENT')
  );
}

function toFriendlyBrowserError(err) {
  const friendly = new Error('No se pudo generar el PDF porque el navegador del servidor no está disponible. Intentá nuevamente en unos minutos.');
  friendly.name = 'PuppeteerBrowserUnavailableError';
  friendly.statusCode = 503;
  friendly.cause = err;
  return friendly;
}

async function launchBrowser(options = {}) {
  const executablePath = resolveExecutablePath();
  const launchOptions = {
    headless: true,
    ...options,
    args: [...DEFAULT_ARGS, ...(options.args || [])],
    ...(executablePath ? { executablePath } : {}),
  };

  try {
    return await puppeteer.launch(launchOptions);
  } catch (err) {
    if (isBrowserMissingError(err)) throw toFriendlyBrowserError(err);
    throw err;
  }
}

module.exports = {
  DEFAULT_ARGS,
  SYSTEM_BROWSER_PATHS,
  launchBrowser,
  resolveExecutablePath,
};
