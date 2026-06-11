import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

// Go direct to RPID
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
console.log('URL:', page.url());

// Look at all buttons and links
const buttons = await page.getByRole('button').all();
console.log('Buttons:', await Promise.all(buttons.map(b => b.textContent())));

const links = await page.getByRole('link').all();
console.log('Links:', await Promise.all(links.map(l => l.textContent())));

const inputs = await page.locator('input').all();
console.log('Inputs:', await Promise.all(inputs.map(i => i.getAttribute('type').catch(() => 'unknown'))));

await page.screenshot({ path: '/tmp/auth-page2.png', fullPage: true });
console.log('Screenshot saved');
await browser.close();
