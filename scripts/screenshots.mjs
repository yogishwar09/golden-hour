/**
 * Regenerates the screenshots used in the README.
 *
 * Drives the real application in a headless browser rather than using mockups,
 * so the images cannot drift from what the app actually looks like. Uses the
 * system Chrome via Playwright's `channel`, so no browser is downloaded.
 *
 * Needs the stack running and seeded:
 *   npm run seed && npm run dev
 *   npm run simulate        # so the fleet is moving
 *   npm run screenshots
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const OUT = new URL('../docs/screenshots', import.meta.url).pathname;
const PASSWORD = 'Password123';

const browser = await chromium.launch({ channel: 'chrome' });

async function shot(name, email, path, { width = 1440, height = 900, settle = 9000, before } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    // Banjara Hills, so the patient screen has a sensible location.
    geolocation: { latitude: 17.4156, longitude: 78.4347 },
    permissions: ['geolocation'],
  });
  const page = await context.newPage();

  // Sign in through the API and hand the token to the app, so the shots show
  // the screens rather than the login form.
  await page.goto(BASE);
  await page.evaluate(async ([base, mail, pass]) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: mail, password: pass }),
    });
    const d = await r.json();
    localStorage.setItem('sas.accessToken', d.accessToken);
  }, [BASE, email, PASSWORD]);

  await page.goto(BASE + path);
  await page.waitForTimeout(settle);
  if (before) await before(page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('captured', name);
  await context.close();
}

await shot('control-room', 'admin@demo.test', '/control');
await shot('patient-tracking', 'rahul@demo.test', '/sos');
await shot('patient-sos', 'patient@demo.test', '/sos');
await shot('hospital-board', 'hospital@demo.test', '/hospital');
await shot('mobile-tracking', 'rahul@demo.test', '/sos', { width: 390, height: 844 });

await browser.close();
