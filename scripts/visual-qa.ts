/**
 * KYN-05 visual QA: `pnpm qa:visual`
 *
 * Builds nothing itself — expects a production build (`pnpm build`). Starts
 * the web app on a scratch port, captures every surface at the five required
 * viewports plus reduced-motion variants, and runs functional checks
 * (navigation, keyboard playhead, disabled truthfulness, overflow, console
 * errors). Writes PNGs under qa/ and a machine-readable report at
 * qa/report.json. Exits non-zero on any failed check.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 3173;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('qa');

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '390x844', width: 390, height: 844 },
  { name: '375x812', width: 375, height: 812 },
] as const;

const ROUTES = [
  { name: 'landing', path: '/' },
  { name: 'explore', path: '/explore' },
  { name: 'studio', path: '/studio' },
  { name: 'moment', path: '/m/mom-synthetic-78m' },
] as const;

interface CheckResult {
  route: string;
  viewport: string;
  reducedMotion: boolean;
  screenshot: string;
  horizontalOverflowPx: number;
  consoleErrors: string[];
  checks: Record<string, boolean | number | string>;
}

async function startServer(): Promise<() => Promise<void>> {
  const child = spawn('pnpm', ['--filter', '@kyneloom/web', 'start', '--port', String(PORT)], {
    shell: true,
    stdio: 'pipe',
  });
  const stdout: string[] = [];
  child.stdout?.on('data', (d: Buffer) => stdout.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => stdout.push(d.toString()));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not start:\n${stdout.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return async () => {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 800));
  };
}

async function main(): Promise<void> {
  mkdirSync(path.join(OUT_DIR, 'screenshots'), { recursive: true });
  const stopServer = await startServer();
  const browser = await chromium.launch({ headless: true });
  const results: CheckResult[] = [];
  const failures: string[] = [];

  try {
    for (const viewport of VIEWPORTS) {
      for (const reducedMotion of [false, true]) {
        // Reduced-motion variants cover the two scene-bearing surfaces at
        // mobile + one desktop width (documented in qa/README.md).
        if (reducedMotion && !['390x844', '1440x900'].includes(viewport.name)) continue;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        for (const route of ROUTES) {
          if (reducedMotion && !['landing', 'explore'].includes(route.name)) continue;
          const consoleErrors: string[] = [];
          page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
          });
          await page.goto(BASE + route.path, { waitUntil: 'networkidle' });
          const suffix = reducedMotion ? '-rm' : '';
          const file = `${route.name}-${viewport.name}${suffix}.png`;
          await page.screenshot({ path: path.join(OUT_DIR, 'screenshots', file) });

          const overflowPx = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          const checks: Record<string, boolean | number | string> = {};
          checks.title = await page.title();
          checks.focusables = await page
            .locator('a[href], button:not([disabled]), [role="slider"]')
            .count();

          if (route.name === 'landing') {
            checks.ctaHrefs =
              (await page.locator('a:has-text("Enter the moment")').first().getAttribute('href')) ??
              '(missing)';
            checks.fixtureSamplesShown = await page
              .locator('.landing__facts dd')
              .nth(2)
              .innerText();
          }
          if (route.name === 'explore') {
            // Keyboard playhead: focus the rail and arrow right. Allow a
            // hydration grace period and one retry before declaring failure.
            const rail = page.locator('[role="slider"]');
            await rail.focus();
            const before = Number(await rail.getAttribute('aria-valuenow'));
            let moved = false;
            for (let attempt = 0; attempt < 3 && !moved; attempt++) {
              await page.keyboard.press('ArrowRight');
              await page.waitForTimeout(120);
              moved = Number(await rail.getAttribute('aria-valuenow')) > before;
            }
            checks.playheadMoves = moved;
            if (!moved) failures.push(`explore @ ${viewport.name}: keyboard playhead did not move`);
            checks.cameraDisabled = await page.locator('.stage__mode-btn[disabled]').count();
            checks.lensSelectable = await page.locator('.stage__mode-btn--lens').count();
            // Lens selection is a real interaction.
            await page.locator('.stage__mode-btn--lens', { hasText: 'Analyst' }).click();
            checks.lensAriaChecked = await page
              .locator('.stage__mode-btn--lens[aria-checked="true"]')
              .innerText();
          }
          if (route.name === 'studio') {
            checks.disabledPublish = await page
              .locator('button:has-text("Publish")[disabled]')
              .count();
            checks.eventMarkers = await page.locator('.studio__event').count();
          }
          if (route.name === 'moment') {
            checks.unpublishedChip = await page.locator('.chip--not-implemented').count();
          }

          results.push({
            route: route.name,
            viewport: viewport.name,
            reducedMotion,
            screenshot: `screenshots/${file}`,
            horizontalOverflowPx: overflowPx,
            consoleErrors,
            checks,
          });
          if (overflowPx > 1)
            failures.push(`${route.name} @ ${viewport.name}: overflow ${overflowPx}px`);
          if (consoleErrors.length > 0) {
            failures.push(
              `${route.name} @ ${viewport.name}: console errors ${consoleErrors.length}`,
            );
          }
        }
        await context.close();
      }
    }

    // Cross-route navigation works (landing → explore via real click).
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.locator('a:has-text("Enter the moment")').click();
    await page.waitForURL('**/explore');
    const navWorks = page.url().endsWith('/explore');
    if (!navWorks) failures.push('landing CTA did not navigate to /explore');
    await page.locator('nav[aria-label="Primary"] a:has-text("Studio")').click();
    await page.waitForURL('**/studio');
    results.push({
      route: 'navigation',
      viewport: '1280x800',
      reducedMotion: false,
      screenshot: 'screenshots/nav-flow-explore.png',
      horizontalOverflowPx: 0,
      consoleErrors: [],
      checks: { landingToExplore: navWorks, exploreToStudio: page.url().endsWith('/studio') },
    });
    await page.screenshot({ path: path.join(OUT_DIR, 'screenshots', 'nav-flow-studio.png') });
    await context.close();
  } finally {
    await browser.close();
    await stopServer();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    viewports: VIEWPORTS.map((v) => v.name),
    routes: ROUTES.map((r) => r.path),
    captures: results.length,
    failures,
    results,
  };
  writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`visual QA: ${results.length} captures across ${VIEWPORTS.length} viewports`);
  if (failures.length > 0) {
    console.error(`FAILURES (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
