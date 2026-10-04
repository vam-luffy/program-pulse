/**
 * Capture the dashboard at 1280x720 (the demo-video size) using an installed Chrome/Edge.
 *   npm run screenshot -- [--url http://localhost:5173] [--out docs/screenshot.png] [--wait 8000]
 * Set CHROME_PATH if Chrome/Edge is not in a standard location.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = arg('url', 'http://localhost:5173');
const out = resolve(ROOT, arg('out', 'docs/screenshot.png'));
const wait = Number(arg('wait', '8000'));

const candidates = [
  process.env.CHROME_PATH,
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => !!p);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.program', { timeout: 30_000 });
await new Promise((r) => setTimeout(r, wait));
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out as `${string}.png` });
const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
console.log(text);
console.log(`saved ${out}`);
await browser.close();
