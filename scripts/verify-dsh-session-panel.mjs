/** UI regression against an isolated DSH host configured with the synthetic local model. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const [addressFile, reportFile, browserPath] = process.argv.slice(2);
let browser;
let stage = 'fixture';
const report = { syntheticDataOnly: true };
try {
  const address = JSON.parse(await fs.readFile(addressFile, 'utf8'));
  if (address.fixture !== true || address.model !== 'synthetic-model') throw Error('ISOLATED_FIXTURE_REQUIRED');
  browser = await chromium.launch({ executablePath: browserPath || process.env.DSH_WRITING_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', () => errors.push(true));
  stage = 'open'; await page.goto(address.url, { waitUntil: 'domcontentloaded' });
  const continued = page.getByRole('button', { name: '继续', exact: true });
  await page.locator('[data-writing-panel]').waitFor({ timeout: 30000 });
  if (await continued.count()) await continued.click();
  stage = 'new-session';
  assert.equal(await page.getByText('探索未至之境', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('[data-writing-panel]').count(), 1);
  assert.equal(await page.getByText('写作模型：synthetic-model', { exact: true }).isVisible(), true);
  report.heroVisible = true;
  const editor = page.locator('[contenteditable=true]').first();
  await editor.fill('SYNTHETIC_UI_REQUEST'); await editor.press('Enter');
  stage = 'existing-session';
  await page.getByText('SYNTHETIC_UI_REPLY', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByText('探索未至之境', { exact: true }).count(), 0);
  assert.equal(await page.locator('[data-writing-panel]').isVisible(), true);
  report.existingVisible = true;
  stage = 'reload'; await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-writing-panel]').waitFor();
  assert.equal(await page.locator('[data-writing-panel]').count(), 1);
  report.afterReloadVisible = true;
  stage = 'narrow-layout'; await page.setViewportSize({ width: 480, height: 800 });
  assert.equal(await page.locator('[data-writing-panel]').isVisible(), true);
  report.narrowVisible = true;
  report.pageErrors = errors.length; assert.equal(errors.length, 0);
  report.ok = true;
} catch {
  report.ok = false; report.stage = stage; report.category = 'UI_REGRESSION_FAILED'; process.exitCode = 1;
} finally { await browser?.close(); }
if (reportFile) await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
