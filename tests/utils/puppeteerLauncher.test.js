describe('puppeteerLauncher', () => {
  const originalEnv = process.env.PUPPETEER_EXECUTABLE_PATH;

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    if (originalEnv === undefined) {
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
    } else {
      process.env.PUPPETEER_EXECUTABLE_PATH = originalEnv;
    }
  });

  test('usa PUPPETEER_EXECUTABLE_PATH cuando esta configurado', async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/custom/chrome';
    const launch = jest.fn().mockResolvedValue({ close: jest.fn() });
    jest.doMock('puppeteer', () => ({ launch }));

    const { launchBrowser } = require('../../src/utils/puppeteerLauncher');
    await launchBrowser();

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: '/custom/chrome',
    }));
  });

  test('convierte browser faltante en error amigable', async () => {
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
    jest.doMock('fs', () => ({ existsSync: jest.fn().mockReturnValue(false) }));
    jest.doMock('puppeteer', () => ({
      launch: jest.fn().mockRejectedValue(new Error('Could not find Chrome (ver. 147.0.7727.57)')),
    }));

    const { launchBrowser } = require('../../src/utils/puppeteerLauncher');

    await expect(launchBrowser()).rejects.toMatchObject({
      name: 'PuppeteerBrowserUnavailableError',
      statusCode: 503,
      message: expect.stringContaining('No se pudo generar el PDF'),
    });
  });
});
