import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

const EMAIL = 'shotbot495@example.com';
const PASS = 'P@ssw0rd!RallyTest495';

page.on('console', msg => { if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text()); });

// Go to sign-in first
await page.goto('http://localhost:5173/signin', { waitUntil: 'domcontentloaded' });
console.log('Signin URL:', page.url());

// Click "Create an account"
await page.getByRole('link', { name: /create an account/i }).click();
await page.waitForURL(/signup|register/, { timeout: 10000 }).catch(() => {});
console.log('After click URL:', page.url());

await page.waitForTimeout(3000); // wait for Turnstile/page to load
console.log('After wait URL:', page.url());
await page.screenshot({ path: '/tmp/signup-page.png', fullPage: true });

const inputs = await page.locator('input').all();
console.log('Input types:', await Promise.all(inputs.map(i => i.getAttribute('type').catch(() => 'unknown'))));
const buttons = await page.getByRole('button').all();
console.log('Buttons:', await Promise.all(buttons.map(b => b.textContent())));

// Fill out form
const emailInput = page.locator('input[type="email"]');
if (await emailInput.isVisible().catch(() => false)) {
  await emailInput.fill(EMAIL);
  console.log('Filled email');
}

const pwInputs = page.locator('input[type="password"]');
const pwCount = await pwInputs.count();
console.log('Password fields:', pwCount);
for (let i = 0; i < pwCount; i++) {
  await pwInputs.nth(i).fill(PASS);
}

// Maybe there's a name field
const textInputs = page.locator('input[type="text"]');
const textCount = await textInputs.count();
console.log('Text inputs:', textCount);

await page.screenshot({ path: '/tmp/signup-filled.png', fullPage: true });

// Submit
const submitBtn = page.getByRole('button', { name: /create|sign up|register|continue|submit/i }).first();
if (await submitBtn.isVisible().catch(() => false)) {
  console.log('Submit button text:', await submitBtn.textContent());
  await submitBtn.click();
  await page.waitForTimeout(3000);
  console.log('After submit URL:', page.url());
}

await page.screenshot({ path: '/tmp/signup-after.png', fullPage: true });

await browser.close();
