/**
 * KYN-11 visual iteration helper (developer tool, not part of qa:visual).
 * Expects the production server on PORT (default 3190) and captures the
 * three lens presentations — Fan, Analyst, Accessible — plus transitions
 * and mobile layouts, so the operator can inspect real rendered pixels.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3190';
const OUT = 'qa/iterations/kyn11';

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
] as const;

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/explore`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (window as { __kyneloomLens?: unknown }).__kyneloomLens !== undefined,
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(1500);

    // FAN — cinematic default.
    await page.screenshot({ path: `${OUT}/fan-${viewport.name}.png` });

    // ANALYST — same instant, evidence rail.
    await page.getByRole('radio', { name: 'Analyst' }).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/analyst-${viewport.name}.png` });
    // Analyst with X-Ray + inspector.
    await page.getByRole('button', { name: 'Show X-Ray' }).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/analyst-xray-${viewport.name}.png` });
    await page.getByRole('button', { name: 'Source evidence' }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/analyst-inspector-${viewport.name}.png` });

    // ACCESSIBLE — description + transcript panel.
    await page
      .getByRole('button', { name: 'Close inspector' })
      .click()
      .catch(() => undefined);
    await page.getByRole('radio', { name: 'Accessible' }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/accessible-${viewport.name}.png` });
    // 2D opt-in.
    const use2d = page.getByRole('button', { name: 'Switch to the 2D tactical view' });
    if ((await use2d.count()) === 1) {
      await use2d.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/accessible-2d-${viewport.name}.png` });
    }

    // Reduced-motion variant at desktop (fan + analyst).
    if (viewport.name === '1440x900') {
      const rmContext = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: 'reduce',
      });
      const rmPage = await rmContext.newPage();
      await rmPage.goto(`${BASE}/explore`, { waitUntil: 'load' });
      await rmPage.waitForFunction(
        () => (window as { __kyneloomLens?: unknown }).__kyneloomLens !== undefined,
        undefined,
        { timeout: 30_000 },
      );
      await rmPage.waitForTimeout(900);
      await rmPage.screenshot({ path: `${OUT}/fan-1440x900-rm.png` });
      await rmPage.getByRole('radio', { name: 'Analyst' }).click();
      await rmPage.waitForTimeout(600);
      await rmPage.screenshot({ path: `${OUT}/analyst-1440x900-rm.png` });
      await rmContext.close();
    }
    await context.close();
  }
  await browser.close();
  console.log(`iteration captures written to ${OUT}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
