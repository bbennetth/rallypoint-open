import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
console.log('URL:', page.url());

// Get the page HTML snippet
const html = await page.content();
// Print first 3000 chars
console.log(html.substring(0, 4000));

await page.screenshot({ path: '/tmp/auth-page.png' });
await browser.close();
