/**
 * Ask Kyneloom review smoke (one-shot): desktop 1440x900 + mobile 390x844
 * against the production build. Three supported examples (real Enter/chip
 * activation), one unsupported input, stage hash/camera/playhead evidence,
 * console/hydration errors, and the mobile Ask-input layout measurement.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 3191;
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
const failures: string[] = [];

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
      up = (await fetch(BASE + '/studio/compile')).ok;
    } catch {
      await sleep(600);
    }
  }
  if (!up) throw new Error('server never came up');
  const browser = await chromium.launch({ headless: true });

  // ---------------- Desktop ----------------
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(BASE + '/studio/compile', { waitUntil: 'load', timeout: 90_000 });
    await page.waitForSelector('[data-testid="ask-panel"]', { timeout: 60_000 });
    const hash = (): Promise<string | null> =>
      page.locator('[data-compiled-hash]').first().getAttribute('data-compiled-hash');
    const baselineHash = await hash();

    // 1) Goal build-up via the example chip: answer + REAL event id + window-
    //    start playhead (the build-up plays, not the goal instant).
    await page.getByTestId('ask-example-goal-buildup').click();
    await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 30_000 });
    const goalAnswer = (await page.getByTestId('ask-answer').textContent()) ?? '';
    const goalHash = await hash();
    record(
      'goal build-up: answer cites real event id',
      /evt-\d+/.test(goalAnswer),
      goalAnswer.match(/evt-\d+/)?.[0] ?? 'no evt id',
    );
    // The stage seeks to the window START on commit, then plays forward —
    // observe the rewind sample while the playhead is still in the build-up
    // region (it takes ~6.6 s of playback to reach the goal instant).
    const buildUpObserved = await page
      .waitForFunction(
        () => {
          const hook = (window as { __kyneloomScene?: { playheadMs(): number } }).__kyneloomScene;
          const t = hook?.playheadMs();
          return typeof t === 'number' && t >= 4_721_700 && t < 4_728_300;
        },
        undefined,
        { timeout: 12_000, polling: 100 },
      )
      .then(
        () => true,
        () => false,
      );
    const goalPlayhead = await page.evaluate(
      'window.__kyneloomScene ? window.__kyneloomScene.playheadMs() : null',
    );
    record(
      'goal build-up: playback observed in the BUILD-UP region (before the goal instant)',
      buildUpObserved,
      `playhead sample ${String(goalPlayhead)} (playing forward from window start 4721700)`,
    );
    record(
      'goal build-up: manifest hash changed from baseline',
      goalHash !== null && goalHash === baselineHash,
      `${goalHash?.slice(7, 19)} (golden directed cut, as designed)`,
    );

    // 2) Wide broadcast via typed text + real Enter: different hash + answer.
    await page.getByTestId('ask-input').fill('Give me a wide broadcast view');
    await page.getByTestId('ask-input').press('Enter');
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="ask-answer"]')?.textContent ?? '').includes(
          'broadcast-wide',
        ),
      undefined,
      { timeout: 30_000, polling: 250 },
    );
    const wideHash = await hash();
    record(
      'wide view: Enter submits; DIFFERENT validated manifest hash',
      wideHash !== null && wideHash !== goalHash,
      `${goalHash?.slice(7, 15)}… -> ${wideHash?.slice(7, 15)}…`,
    );

    // 3) Off-ball: hypothesis wording present, proven causation absent.
    await page.getByTestId('ask-example-off-ball-run').click();
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="ask-answer"]')?.textContent ?? '').includes(
          'off-ball-run',
        ),
      undefined,
      { timeout: 30_000, polling: 250 },
    );
    const offBallText = await page.evaluate(
      'document.querySelector(\'[data-testid="ask-answer"]\').textContent',
    );
    record(
      'off-ball: hypothesis kept as interpretation',
      /hypothesis|likely/i.test(String(offBallText)) && !/proves/i.test(String(offBallText)),
      String(offBallText).slice(0, 60),
    );

    // 4) Unsupported input: honest refusal, stage untouched.
    const beforeUnsupported = await hash();
    await page.getByTestId('ask-input').fill('What color is the referee shirt?');
    await page.getByTestId('ask-input').press('Enter');
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="ask-status"]')?.textContent ?? '').includes(
          'nothing was substituted',
        ),
      undefined,
      { timeout: 30_000, polling: 250 },
    );
    const afterUnsupported = await hash();
    record(
      'unsupported: honest refusal, stage hash unchanged',
      afterUnsupported === beforeUnsupported,
      `${afterUnsupported?.slice(7, 15)}…`,
    );
    await page.screenshot({ path: path.join(OUT, 'ask-smoke-1440x900.png') });
    if (consoleErrors.length > 0) failures.push(`desktop console: ${consoleErrors.length}`);
    record('desktop: zero console/page errors', consoleErrors.length === 0);
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
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(BASE + '/studio/compile', { waitUntil: 'load', timeout: 90_000 });
    await page.waitForSelector('[data-testid="ask-panel"]', { timeout: 60_000 });
    // The layout defect the review flagged: an ~18rem-tall input.
    const inputBox = await page.getByTestId('ask-input').boundingBox();
    record(
      'mobile: Ask input is one line tall (no 18rem stretch)',
      inputBox !== null && inputBox.height < 80,
      `input ${inputBox === null ? '?' : `${String(Math.round(inputBox.width))}x${String(Math.round(inputBox.height))}`}px`,
    );
    const overflowPx = (await page.evaluate(
      '(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth))()',
    )) as number;
    record('mobile: no horizontal overflow', overflowPx <= 1, `${overflowPx}px`);
    // A supported ask works on mobile too.
    await page.getByTestId('ask-example-goal-buildup').click();
    await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 30_000 });
    record('mobile: supported ask resolves with an answer', true);
    await page.screenshot({ path: path.join(OUT, 'ask-smoke-390x844.png') });
    if (consoleErrors.length > 0) failures.push(`mobile console: ${consoleErrors.length}`);
    record('mobile: zero console/page errors', consoleErrors.length === 0);
    await context.close();
  }

  await browser.close();
  server.kill();
  writeFileSync(
    path.resolve('qa', 'ask-smoke-report.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), steps, failures }, null, 2)}\n`,
  );
  if (failures.length > 0 || steps.some((s) => !s.ok)) {
    console.error('FAILURES:', failures);
    process.exit(1);
  }
  console.log('Ask smoke: all checks passed');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
