import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

// Capture console errors
page.on('console', msg => console.log('CONSOLE:', msg.type(), msg.text()));
page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

// Navigate to sign-in directly
await page.goto('http://localhost:5173/signin', { waitUntil: 'networkidle' });
console.log('URL:', page.url());

const buttons = await page.getByRole('button').all();
console.log('Buttons:', await Promise.all(buttons.map(b => b.textContent())));

const links = await page.getByRole('link').all();
console.log('Links:', await Promise.all(links.map(l => l.textContent())));

const inputs = await page.locator('input').all();
console.log('Input types:', await Promise.all(inputs.map(i => i.getAttribute('type').catch(() => 'unknown'))));

await page.screenshot({ path: '/tmp/auth-signin.png', fullPage: true });
console.log('Screenshot saved');

// Try navigating to signup
await page.goto('http://localhost:5173/signup', { waitUntil: 'networkidle' });
console.log('Signup URL:', page.url());
const buttons2 = await page.getByRole('button').all();
console.log('Signup Buttons:', await Promise.all(buttons2.map(b => b.textContent())));
await page.screenshot({ path: '/tmp/auth-signup.png', fullPage: true });

await browser.close();
