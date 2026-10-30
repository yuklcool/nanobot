import { defineConfig, devices } from "@playwright/test";

const gatewayPython = process.env.NANOBOT_OPENUI_GATEWAY_PYTHON;
const gatewayPort = Number(process.env.NANOBOT_OPENUI_GATEWAY_PORT ?? 18765);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const port = Number(process.env.NANOBOT_BROWSER_TEST_PORT ?? 4178);

export default defineConfig({
  testDir: "./browser",
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  outputDir: "test-results/browser",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    reducedMotion: "no-preference",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    screenshot: "only-on-failure",
  },
  webServer: [{
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/browser/fixture.html`,
    reuseExistingServer: false,
    env: gatewayPython ? { NANOBOT_API_URL: `http://127.0.0.1:${gatewayPort}` } : {},
  }, ...(gatewayPython ? [{
    command: `${quote(gatewayPython)} ../tests/openui/gateway_fixture.py --port ${gatewayPort}`,
    url: `http://127.0.0.1:${gatewayPort}/webui/terminal`,
    reuseExistingServer: false,
    timeout: 60_000,
  }] : [])],
});
