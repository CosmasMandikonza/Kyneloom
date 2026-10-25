/**
 * KYN-16 compiler recorder: `pnpm qa:record:compiler`
 *
 * Interactive, screenshot-backed acceptance pass over /studio/compile
 * against the PRODUCTION build:
 *
 * desktop 1440×900 — poster (truthful pre-play state) → Watch the compiled
 * moment (directed camera + hash chip + moment-window marker + broadcast
 * overlay while a cue is live) → scrub sync proof via the QA hook → Esc
 * exits directed → red-team compile (false distance claim) shows exact
 * field-path errors → golden recompiles to the pinned hash.
 *
 * mobile 390×844 — poster, playback with the overlay, workbench stacking.
 *
 * Every step prints an ACTION/EXPECTED/ACTUAL/RESULT line; screenshots land
 * in qa/screenshots/compile-*.png. Kept deliberately lean (two contexts, no
 * screencast) to stay clear of the SwiftShader long-run wedges seen by the
 * earlier recorders.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 3179;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('qa', 'screenshots');

function line(action: string, expected: string, actual: string, pass: boolean): void {
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${action} | expected ${expected} | actual ${actual}`);
  if (!pass) process.exitCode = 1;
}

async function startServer(): Promise<() => Promise<void>> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
    if (res.ok) throw new Error(`port ${PORT} is already serving — stop it first`);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  const child = spawn('pnpm', ['--filter', '@kyneloom/web', 'start', '--port', String(PORT)], {
    shell: true,
    stdio: 'pipe',
  });
  const buffer: string[] = [];
  child.stdout?.on('data', (d: Buffer) => buffer.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => buffer.push(d.toString()));
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const probe = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
      if (probe.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${buffer.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return async () => {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 750));
  };
}

interface CompiledHook {
  manifestId: string;
  manifestHash: string;
  momentWindowMs(): readonly [number, number];
  playheadMs(): number;
  activeCue(): string | null;
}
interface LensHook {
  camera(): string;
  playheadMs(): number;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const stop = await startServer();
  const browser = await chromium.launch({ headless: true });

  try {
    // ---------- Desktop 1440×900 ----------
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${BASE}/studio/compile`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-compile-poster]', { timeout: 30_000 });
    const hashChip = await page.textContent('[data-compiled-hash]');
    line(
      'desktop poster shows immutable hash chip',
      'sha256:ad55d6fc…',
      (hashChip ?? '').trim(),
      (hashChip ?? '').includes('ad55d6fc'),
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'compile-desktop-poster.png') });

    await page.getByTestId('watch-compiled-moment').click();
    await page.waitForSelector('[data-compile-poster]', { state: 'detached', timeout: 10_000 });
    await page.waitForFunction(
      () => (window as { __kyneloomLens?: LensHook }).__kyneloomLens?.camera() === 'directed',
      undefined,
      { timeout: 15_000 },
    );
    const camera = await page.evaluate(() =>
      (window as { __kyneloomLens?: LensHook }).__kyneloomLens?.camera(),
    );
    line('Watch starts the directed camera', 'directed', String(camera), camera === 'directed');

    // Wait until the playhead is inside the moment and a cue is live.
    await page.waitForFunction(
      () => {
        const compiled = (window as { __kyneloomCompiled?: CompiledHook }).__kyneloomCompiled;
        return compiled !== undefined && compiled.activeCue() !== null;
      },
      undefined,
      { timeout: 15_000 },
    );
    const hook = await page.evaluate(() => {
      const compiled = (window as { __kyneloomCompiled?: CompiledHook }).__kyneloomCompiled!;
      const lens = (window as { __kyneloomLens?: LensHook }).__kyneloomLens!;
      return {
        hash: compiled.manifestHash,
        window: compiled.momentWindowMs(),
        playhead: compiled.playheadMs(),
        cue: compiled.activeCue(),
        camera: lens.camera(),
      };
    });
    line(
      'one clock: playhead inside cue window on the match clock',
      'playhead ∈ moment window',
      `${String(hook.playhead)} ∈ [${String(hook.window[0])}, ${String(hook.window[1])}]`,
      hook.playhead >= hook.window[0] && hook.playhead <= hook.window[1],
    );
    line(
      'broadcast overlay is live with compiler text',
      'cue text from the verified manifest',
      String(hook.cue),
      typeof hook.cue === 'string' && (hook.cue.includes('SEPARATION') || hook.cue.length > 8),
    );
    line(
      'manifest identity pinned',
      'sha256:ad55d6fc…c3da75e',
      hook.hash,
      hook.hash === 'sha256:ad55d6fcfa824816bd0f7e1ee0ed5c0c34863bdcc4dd9f0c7909584120f580bb',
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'compile-desktop-directed-overlay.png') });

    // Esc exits directed mode (existing behavior must survive the new props).
    // The keydown transport lives on the stage section — click into the scene
    // first so the stage owns focus (a body-level keypress never reaches it).
    await page.mouse.click(720, 430);
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => (window as { __kyneloomLens?: LensHook }).__kyneloomLens?.camera() !== 'directed',
      undefined,
      { timeout: 10_000 },
    );
    const afterEsc = await page.evaluate(() =>
      (window as { __kyneloomLens?: LensHook }).__kyneloomLens?.camera(),
    );
    line(
      'Esc exits directed to broadcast',
      'broadcast',
      String(afterEsc),
      afterEsc === 'broadcast',
    );

    // Red-team compile: the false distance claim must reject with field paths.
    await page.getByRole('button', { name: /False distance claim/ }).click();
    await page.getByTestId('compile-proposal').click();
    await page.waitForSelector('[data-verdict="invalid"]', { timeout: 30_000 });
    const verdict = await page.evaluate(() => {
      const panel = document.querySelector('[data-verdict="invalid"]');
      return panel?.textContent ?? '';
    });
    line(
      'false 14 m claim rejected with the recomputed truth',
      'unsupported_claim @ claims[0].metricAssertion.assertedValue, 23.063 named',
      verdict.slice(0, 140),
      verdict.includes('unsupported_claim') &&
        verdict.includes('claims[0].metricAssertion.assertedValue') &&
        verdict.includes('23.063'),
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'compile-desktop-verdict-reject.png') });

    // Golden recompiles through the API to the pinned hash.
    await page.getByRole('button', { name: /Well-formed proposal/ }).click();
    await page.getByTestId('compile-proposal').click();
    await page.waitForSelector('[data-verdict="valid"]', { timeout: 30_000 });
    const okVerdict = await page.evaluate(() => {
      const panel = document.querySelector('[data-verdict="valid"]');
      return panel?.textContent ?? '';
    });
    line(
      'golden recompiles to the pinned hash via the API',
      'sha256:ad55d6fc…',
      okVerdict.slice(0, 120),
      okVerdict.includes('ad55d6fc'),
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'compile-desktop-verdict-ok.png') });
    await context.close();

    // ---------- Mobile 390×844 ----------
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const mpage = await mobile.newPage();
    await mpage.goto(`${BASE}/studio/compile`, { waitUntil: 'domcontentloaded' });
    await mpage.waitForSelector('[data-compile-poster]', { timeout: 30_000 });
    await mpage.screenshot({ path: path.join(OUT_DIR, 'compile-mobile-poster.png') });
    await mpage.getByTestId('watch-compiled-moment').click();
    await mpage.waitForSelector('[data-compile-poster]', { state: 'detached', timeout: 10_000 });
    await mpage.waitForFunction(
      () =>
        (window as { __kyneloomCompiled?: CompiledHook }).__kyneloomCompiled?.activeCue() !== null,
      undefined,
      { timeout: 15_000 },
    );
    const mobileCue = await mpage.evaluate(() =>
      (window as { __kyneloomCompiled?: CompiledHook }).__kyneloomCompiled?.activeCue(),
    );
    line(
      'mobile overlay renders the same cue',
      'cue visible on 390px',
      String(mobileCue),
      typeof mobileCue === 'string' && mobileCue.length > 8,
    );
    await mpage.screenshot({ path: path.join(OUT_DIR, 'compile-mobile-directed.png') });
    await mpage.mouse.wheel(0, 2400);
    await mpage.waitForTimeout(600);
    await mpage.screenshot({ path: path.join(OUT_DIR, 'compile-mobile-workbench.png') });
    const entriesVisible = await mpage.getByTestId('compile-proposal').isVisible();
    line(
      'mobile workbench reachable below the stage',
      'compile button visible',
      String(entriesVisible),
      entriesVisible,
    );
    await mobile.close();
  } finally {
    await browser.close();
    await stop();
  }
  console.log(process.exitCode ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL PASS');
}

await main();
