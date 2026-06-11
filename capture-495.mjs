import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'fs';

const SCREENSHOTS_DIR = '/home/byron/gh/rallypoint-core/.claude/worktrees/crazy-khorana-50c5b6/docs/screenshots/issue-495';
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const PLANNER = 'http://localhost:5177';
const ID = 'http://localhost:5173';
const EMAIL = 'shotbot495@example.com';
const PASS = 'P@ssw0rd!RallyTest495';

async function main() {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  console.log('Navigating to Planner...');
  await page.goto(PLANNER, { waitUntil: 'networkidle' });
  console.log('Current URL:', page.url());

  // Sign up / sign in
  if (page.url().includes('localhost:5173') || page.url().includes('signin') || page.url().includes('login')) {
    console.log('On auth page, looking for sign-up...');
    // Try to find "Create account" or "Sign up" link
    const createLink = page.getByRole('link', { name: /create account|sign up|register/i }).first();
    const hasCreate = await createLink.isVisible().catch(() => false);
    if (hasCreate) {
      await createLink.click();
      await page.waitForLoadState('networkidle');
    }
    console.log('URL after looking for signup:', page.url());

    // Fill signup form
    const emailField = page.getByRole('textbox', { name: /email/i }).first();
    const hasEmail = await emailField.isVisible().catch(() => false);
    if (hasEmail) {
      await emailField.fill(EMAIL);
    }

    // Look for password fields
    const passwordFields = page.locator('input[type="password"]');
    const pwCount = await passwordFields.count();
    console.log('Password fields:', pwCount);
    if (pwCount >= 1) {
      await passwordFields.nth(0).fill(PASS);
    }
    if (pwCount >= 2) {
      await passwordFields.nth(1).fill(PASS);
    }

    // Submit
    const submitBtn = page.getByRole('button', { name: /sign up|create|register|continue/i }).first();
    const hasSubmit = await submitBtn.isVisible().catch(() => false);
    if (hasSubmit) {
      await submitBtn.click();
      await page.waitForLoadState('networkidle');
    }
    console.log('After signup URL:', page.url());

    // If still on auth page, try sign in instead
    if (page.url().includes('localhost:5173')) {
      console.log('Trying sign-in flow...');
      const emailField2 = page.getByRole('textbox', { name: /email/i }).first();
      const hasEmail2 = await emailField2.isVisible().catch(() => false);
      if (hasEmail2) {
        await emailField2.fill(EMAIL);
      }
      const pwFields2 = page.locator('input[type="password"]');
      const pwCount2 = await pwFields2.count();
      if (pwCount2 >= 1) {
        await pwFields2.nth(0).fill(PASS);
      }
      const signinBtn = page.getByRole('button', { name: /sign in|log in|continue/i }).first();
      const hasSignin = await signinBtn.isVisible().catch(() => false);
      if (hasSignin) {
        await signinBtn.click();
        await page.waitForLoadState('networkidle');
      }
    }
    console.log('After auth URL:', page.url());
  }

  // Wait for planner to load
  await page.waitForTimeout(2000);
  console.log('Final URL:', page.url());

  // Screenshot 1: after-new-list-drawer.png
  // Navigate to /tasks
  console.log('\n=== Screenshot 1: new-list-drawer ===');
  await page.goto(`${PLANNER}/tasks`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  console.log('Tasks URL:', page.url());
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/debug-tasks-initial.png` });

  // Find and click "New list" pill
  const newListBtn = page.getByRole('button', { name: /new list/i }).first();
  const hasNewList = await newListBtn.isVisible().catch(() => false);
  console.log('Has New List button:', hasNewList);
  if (hasNewList) {
    await newListBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/after-new-list-drawer.png` });
    console.log('✓ after-new-list-drawer.png saved');
  } else {
    console.log('✗ New List button not found');
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/after-new-list-drawer-FAILED.png` });
  }

  // Screenshot 2: after-active-list-settings.png
  // Create two lists first via the drawer
  console.log('\n=== Screenshot 2: active-list-settings ===');
  // Create first list
  async function createList(name) {
    const btn = page.getByRole('button', { name: /new list/i }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(400);
    }
    // Fill the list name
    const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="list" i], input[type="text"]').first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(name);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
    }
  }

  // Close any open drawer first
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await createList('Work Tasks');
  await createList('Personal Tasks');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/debug-after-create-lists.png` });

  // Click on the first list to make it active
  const listItems = page.locator('[data-list-id], [role="tab"], .list-tab, .list-rail button').filter({ hasNotText: /new list/i });
  const listCount = await listItems.count();
  console.log('List items found:', listCount);

  // Try clicking on a specific list
  const firstList = page.getByRole('button', { name: 'Work Tasks' }).first();
  const hasFirst = await firstList.isVisible().catch(() => false);
  if (hasFirst) {
    await firstList.click();
    await page.waitForTimeout(400);
  } else {
    // Try a tab
    const tabs = page.getByRole('tab');
    const tabCount = await tabs.count();
    console.log('Tabs found:', tabCount);
    if (tabCount > 0) {
      await tabs.first().click();
      await page.waitForTimeout(400);
    }
  }

  await page.screenshot({ path: `${SCREENSHOTS_DIR}/after-active-list-settings.png` });
  console.log('✓ after-active-list-settings.png saved (check if ··· visible)');

  // Screenshot 3: after-myday-toggle.png
  console.log('\n=== Screenshot 3: myday-toggle ===');
  await page.goto(`${PLANNER}/me?mode=upcoming`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  console.log('My Day URL:', page.url());

  // Click "Upcoming" if it's a button
  const upcomingBtn = page.getByRole('button', { name: /upcoming/i }).first();
  const hasUpcoming = await upcomingBtn.isVisible().catch(() => false);
  console.log('Has Upcoming button:', hasUpcoming);
  if (hasUpcoming) {
    await upcomingBtn.click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/after-myday-toggle.png` });
  console.log('✓ after-myday-toggle.png saved');

  // Screenshot 4: after-shopping-clear-checked.png
  console.log('\n=== Screenshot 4: shopping-clear-checked ===');
  await page.goto(`${PLANNER}/shopping`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  console.log('Shopping URL:', page.url());
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/debug-shopping-initial.png` });

  // Add items
  async function addShoppingItem(name) {
    // Look for input or add button
    const addInput = page.locator('input[placeholder*="add" i], input[placeholder*="item" i], input[placeholder*="shopping" i]').first();
    const hasInput = await addInput.isVisible().catch(() => false);
    if (hasInput) {
      await addInput.fill(name);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      return;
    }
    // Try a "+" button or "Add item"
    const addBtn = page.getByRole('button', { name: /add item|^\+$/i }).first();
    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(300);
      const newInput = page.locator('input[type="text"]:visible').last();
      await newInput.fill(name);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
    }
  }

  await addShoppingItem('Milk');
  await addShoppingItem('Bread');
  await addShoppingItem('Eggs');

  // Check off first two items
  const checkboxes = page.locator('input[type="checkbox"]');
  const cbCount = await checkboxes.count();
  console.log('Checkboxes:', cbCount);
  if (cbCount >= 1) await checkboxes.nth(0).click();
  await page.waitForTimeout(300);
  if (cbCount >= 2) await checkboxes.nth(1).click();
  await page.waitForTimeout(500);

  await page.screenshot({ path: `${SCREENSHOTS_DIR}/after-shopping-clear-checked.png` });
  console.log('✓ after-shopping-clear-checked.png saved');

  // Screenshot 5: after-notes-truncation.png
  console.log('\n=== Screenshot 5: notes-truncation ===');
  await page.goto(`${PLANNER}/notes`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  console.log('Notes URL:', page.url());
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/debug-notes-initial.png` });

  // Create a note with long title
  const longTitle = 'This is a very long note title that should definitely truncate at 390px width for testing';

  // Find add/new note button
  const newNoteBtn = page.getByRole('button', { name: /new note|add note|\+/i }).first();
  const hasNewNote = await newNoteBtn.isVisible().catch(() => false);
  console.log('Has new note button:', hasNewNote);
  if (hasNewNote) {
    await newNoteBtn.click();
    await page.waitForTimeout(400);
  }

  // Look for a title input
  const titleInput = page.locator('input[placeholder*="title" i], input[placeholder*="note" i], textarea[placeholder*="title" i]').first();
  const hasTitleInput = await titleInput.isVisible().catch(() => false);
  if (hasTitleInput) {
    await titleInput.fill(longTitle);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  }

  // Go back to notes list view
  await page.goto(`${PLANNER}/notes`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/after-notes-truncation.png` });
  console.log('✓ after-notes-truncation.png saved');

  console.log('\nAll screenshots complete!');
  console.log('Files saved to:', SCREENSHOTS_DIR);

  await browser.close();
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
