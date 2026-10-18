/**
 * KYN-10 visual iteration helper (developer tool, not part of qa:visual).
 * Boots nothing itself — expects the production server on PORT (default
 * 3190, `pnpm --filter @kyneloom/web start --port 3190`) and captures the
 * gallery at the five required viewports plus interaction states so the
 * operator can inspect real rendered pixels and iterate.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3190';
const OUT = 'qa/iterations/kyn10';

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '390x844', width: 390, height: 844 },
  { name: '375x812', width: 375, height: 812 },
] as const;

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/moments`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/moments-${viewport.name}.png`, fullPage: true });
    // Featured close-up (above the fold).
    await page.screenshot({ path: `${OUT}/featured-${viewport.name}.png` });
    // Hover state on desktop widths.
    if (viewport.width >= 1024) {
      const card = page.locator('.mcard').nth(2);
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      if (box !== null) {
        await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.32, { steps: 8 });
        await page.waitForTimeout(600);
      }
      await page.screenshot({ path: `${OUT}/hover-${viewport.name}.png` });
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
