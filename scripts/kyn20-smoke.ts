/**
 * KYN-20 ONE-SHOT browser smoke (not committed as a repo script — a bounded
 * verification record): real keyboard activation of the accessible journey
 * at desktop 1440x900 and mobile 390x844 against the production build.
 * Locators position focus; every ACTIVATION is a real keyboard key.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 3190;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('qa', 'screenshots');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Step {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}
const steps: Step[] = [];
const record = (step: string, ok: boolean, detail = ''): void => {
  steps.push({ step, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${step} — ${detail}`);
};

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: 'apps/web',
    shell: true,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 90_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(BASE + '/explore')).ok;
    } catch {
      await sleep(600);
    }
  }
  if (!up) throw new Error('server never came up');
  const browser = await chromium.launch({ headless: true });
  const failures: string[] = [];

  // ---------------- Desktop 1440x900 — keyboard-only journey ----------------
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await page.goto(BASE + '/explore', { waitUntil: 'load', timeout: 90_000 });
    await page.waitForFunction(
      () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
      undefined,
      { timeout: 60_000 },
    );
    // 1-2. Select the Accessible lens with a REAL keyboard activation.
    await page.getByRole('radio', { name: 'Accessible', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.waitForSelector('[data-testid="accessible-panel"]', { timeout: 20_000 });
    record('keyboard: Accessible lens via Space', true);

    // 3. Play/Pause via keyboard on the panel transport.
    const panel = page.getByTestId('accessible-panel');
    await panel
      .getByRole('region', { name: 'Playback' })
      .getByRole('button', { name: 'Play' })
      .focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="live-announcement"]') !== null &&
        (document.querySelector('[data-testid="spatial-description"]') as HTMLElement | null)
          ?.dataset.playhead !== undefined,
      undefined,
      { timeout: 20_000, polling: 300 },
    );
    const playheadWhilePlaying = (await page.evaluate(
      'window.__kyneloomScene.playheadMs()',
    )) as number;
    await panel
      .getByRole('region', { name: 'Playback' })
      .getByRole('button', { name: 'Pause' })
      .focus();
    await page.keyboard.press('Space');
    record('keyboard: Play then Pause via Space', true, `playhead ${playheadWhilePlaying}`);

    // 4. Seek via the canonical slider with real ArrowLeft/ArrowRight keys.
    const slider = page.locator('input.stage__slider');
    const before = Number(await slider.inputValue());
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await sleep(400);
    const afterArrows = Number(await slider.inputValue());
    record(
      'keyboard: ArrowRight seeks the canonical transport',
      afterArrows > before,
      `${before} -> ${afterArrows}`,
    );

    // 5-6. Select a transcript entry via keyboard; provenance id visible.
    const goalEntry = panel.getByRole('button', { name: /GOAL · 78:48.3/ });
    const provenance = await goalEntry.locator('.a11y__entry-id').textContent();
    await goalEntry.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => window.__kyneloomScene!.playheadMs() === 4_728_300,
      undefined,
      { timeout: 20_000, polling: 250 },
    );
    record('keyboard: transcript entry via Enter seeks to 78:48.3', true, `id ${provenance}`);
    // Active entry marked (aria-current) without focus stealing.
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="transcript"] button[aria-current="true"]')
          .length === 1,
      undefined,
      { timeout: 10_000, polling: 250 },
    );
    record('transcript: exactly one aria-current entry at the playhead', true);

    // Follow narration is opt-in: verify aria-pressed=false BEFORE any key.
    const follow = panel.getByTestId('follow-narration');
    const pressedBefore = await follow.getAttribute('aria-pressed');
    await follow.focus();
    await page.keyboard.press('Enter');
    await sleep(300);
    const pressedAfter = await follow.getAttribute('aria-pressed');
    record(
      'narration: strictly opt-in toggle via keyboard',
      pressedBefore === 'false' && pressedAfter === 'true',
      `aria-pressed ${pressedBefore} -> ${pressedAfter}`,
    );

    // Capture the ACCESSIBLE panel (before the lens switch below).
    await page.screenshot({ path: path.join(OUT, 'kyn20-accessible-1440x900.png') });
    // 7-8. Lens change via keyboard preserves the shared playhead.
    await page.getByRole('radio', { name: 'Analyst', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="accessible-panel"]') === null,
      undefined,
      { timeout: 20_000 },
    );
    const playheadAfterLens = (await page.evaluate(
      'window.__kyneloomScene.playheadMs()',
    )) as number;
    record(
      'keyboard: lens switch preserves the shared playhead',
      playheadAfterLens === 4_728_300,
      `playhead ${playheadAfterLens}`,
    );
    if (consoleErrors.length > 0) failures.push(`desktop console errors: ${consoleErrors.length}`);
    await context.close();
  }

  // ---------------- Mobile 390x844 ----------------
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await page.goto(BASE + '/explore', { waitUntil: 'load', timeout: 90_000 });
    await page.waitForFunction(
      () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
      undefined,
      { timeout: 60_000 },
    );
    await page.getByRole('radio', { name: 'Accessible', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.waitForSelector('[data-testid="accessible-panel"]', { timeout: 20_000 });
    const overflowPx = (await page.evaluate(
      '(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth))()',
    )) as number;
    record(
      'mobile 390x844: accessible panel mounts, no horizontal overflow',
      overflowPx <= 1,
      `overflow ${overflowPx}px`,
    );
    // Transcript seek works with a real tap-equivalent (Enter on focused btn).
    const firstEntry = page
      .getByTestId('accessible-panel')
      .getByRole('button', { name: /Pass received/ })
      .first();
    await firstEntry.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => window.__kyneloomScene!.playheadMs() === 4_726_200,
      undefined,
      { timeout: 20_000, polling: 250 },
    );
    record('mobile: transcript seek via keyboard reaches 78:46.2', true);
    await page.screenshot({ path: path.join(OUT, 'kyn20-accessible-390x844.png') });
    if (consoleErrors.length > 0) failures.push(`mobile console errors: ${consoleErrors.length}`);
    await context.close();
  }

  await browser.close();
  server.kill();
  writeFileSync(
    path.resolve('qa', 'kyn20-smoke-report.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), steps, failures }, null, 2)}\n`,
  );
  if (failures.length > 0 || steps.some((s) => !s.ok)) {
    console.error('FAILURES:', failures);
    process.exit(1);
  }
  console.log('KYN-20 smoke: all checks passed');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
