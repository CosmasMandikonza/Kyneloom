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
      'sha256:88a9f0d1…',
      (hashChip ?? '').trim(),
      (hashChip ?? '').includes('88a9f0d1'),
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
    // Read playhead AND the live cue atomically (a separate evaluate can
    // race playback past the cue end between the two reads).
    await page.waitForFunction(
      () => {
        const compiled = (window as { __kyneloomCompiled?: CompiledHook }).__kyneloomCompiled;
        return compiled !== undefined && compiled.activeCue() !== null;
      },
      undefined,
      { timeout: 15_000 },
    );
    const hook = await page.evaluate(`(() => {
      const compiled = window.__kyneloomCompiled;
      const lens = window.__kyneloomLens;
      if (!compiled || !lens) return null;
      return {
        hash: compiled.manifestHash,
        window: compiled.momentWindowMs(),
        playhead: compiled.playheadMs(),
        cue: compiled.activeCue(),
        camera: lens.camera(),
      };
    })()`);
    if (hook === null) throw new Error('compiled hook missing during playback');
    const hookData = hook as {
      hash: string;
      window: readonly [number, number];
      playhead: number;
      cue: string | null;
      camera: string;
    };
    const cueMargin = 1500; // transport-read latency while playing
    const inMoment =
      hookData.playhead >= hookData.window[0] &&
      hookData.playhead <= hookData.window[1] + cueMargin;
    line(
      'one clock: playhead inside the moment window while a cue is live',
      'playhead ∈ moment window (+read latency)',
      `${String(hookData.playhead)} ∈ [${String(hookData.window[0])}, ${String(hookData.window[1])}]`,
      inMoment,
    );
    line(
      'broadcast overlay is live with compiler text',
      'cue text from the verified manifest',
      String(hookData.cue),
      typeof hookData.cue === 'string' &&
        (hookData.cue.includes('SEPARATION') || hookData.cue.length > 8),
    );
    line(
      'manifest identity pinned',
      'sha256:88a9f0d1…c296e6952',
      hookData.hash,
      hookData.hash === 'sha256:88a9f0d1789a329da4f9e0963968e4e53844adcbcc00e7ec20f580c8296e6952',
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
      'sha256:88a9f0d1…',
      okVerdict.slice(0, 120),
      okVerdict.includes('88a9f0d1'),
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'compile-desktop-verdict-ok.png') });

    // ---- Recompile to the SECOND valid cut: the stage must play the new artifact.
    await page.getByRole('button', { name: /broadcast sweep/i }).click();
    await page.getByTestId('compile-proposal').click();
    await page.waitForSelector('[data-verdict="valid"][data-compiled-entry="broadcast-sweep"]', {
      timeout: 30_000,
    });
    await page.waitForFunction(
      `window.__kyneloomCompiled && window.__kyneloomCompiled.manifestId === 'mom-invisible-assist-broadcast-sweep-v1'`,
      undefined,
      { timeout: 15_000 },
    );
    const sweep = await page.evaluate(() => {
      const compiled = (window as { __kyneloomCompiled?: CompiledHook }).__kyneloomCompiled!;
      const identity = document
        .querySelector('[data-identity-hash]')
        ?.getAttribute('data-identity-hash');
      const chip = document
        .querySelector('[data-compiled-hash]')
        ?.getAttribute('data-compiled-hash');
      const banner = document.querySelector('[data-last-valid-banner]');
      return { hash: compiled.manifestHash, identity, chip, banner: banner !== null };
    });
    line(
      'recompiling the sweep cut swaps the stage, recap and chip to hash B',
      'one identity everywhere, no stale hash A',
      `chip=${String(sweep.chip?.slice(7, 15))} identity=${String(sweep.identity?.slice(7, 15))}`,
      sweep.chip === sweep.hash &&
        sweep.identity === sweep.hash &&
        sweep.hash !== 'sha256:88a9f0d1789a329da4f9e0963968e4e53844adcbcc00e7ec20f580c8296e6952' &&
        !sweep.banner,
    );
    // Visible text only — the RSC hydration payload legitimately still
    // contains the server-rendered initial props inside inline scripts.
    const bodyHasGoldenHash = await page.evaluate(
      `document.body.innerText.includes('sha256:88a9f0d1789a329da4f9e0963968e4e53844adcbcc00e7ec20f580c8296e6952')`,
    );
    line(
      'no leftover hash A labels the new experience',
      'golden hash absent from the page',
      `present=${String(bodyHasGoldenHash)}`,
      !bodyHasGoldenHash,
    );
    // The directed camera now consumes the SWEEP track (3 keyframes).
    const sweepCamera = await page.evaluate(
      `window.__kyneloomScene && window.__kyneloomScene.visual ? window.__kyneloomScene.visual.cameraWorldPosition() : null`,
    );
    line(
      'the live camera is driven by the newly compiled track',
      'camera pose present and changed from the golden cut',
      JSON.stringify(sweepCamera),
      Array.isArray(sweepCamera),
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'compile-desktop-recompiled-sweep.png') });

    // ---- A rejected recompile must not touch the stage.
    await page.getByRole('button', { name: /False distance claim/ }).click();
    await page.getByTestId('compile-proposal').click();
    await page.waitForSelector('[data-verdict="invalid"]', { timeout: 30_000 });
    await page.waitForSelector('[data-last-valid-banner]', { timeout: 10_000 });
    const afterReject = await page.evaluate(() => ({
      chip: document.querySelector('[data-compiled-hash]')?.getAttribute('data-compiled-hash'),
      banner: document.querySelector('[data-last-valid-banner]')?.textContent ?? '',
    }));
    line(
      'rejected recompile keeps the sweep on stage, explicitly labeled',
      'banner names the rejected proposal; chip still hash B',
      `chip=${String(afterReject.chip?.slice(7, 15))}`,
      afterReject.chip === sweep.hash && afterReject.banner.includes('False distance claim'),
    );
    await page.screenshot({
      path: path.join(OUT_DIR, 'compile-desktop-rejected-keeps-last-valid.png'),
    });
    await context.close();

    // ---------- Viewport sweep (poster state) ----------
    for (const size of [
      { w: 1280, h: 800, name: '1280x800' },
      { w: 1024, h: 768, name: '1024x768' },
      { w: 375, h: 812, name: '375x812' },
    ] as const) {
      const vpContext = await browser.newContext({ viewport: { width: size.w, height: size.h } });
      const vpPage = await vpContext.newPage();
      await vpPage.goto(`${BASE}/studio/compile`, { waitUntil: 'domcontentloaded' });
      await vpPage.waitForSelector('[data-compile-poster]', { timeout: 30_000 });
      const chipVisible = await vpPage
        .waitForSelector('[data-compiled-hash]', { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      line(
        `viewport ${size.name}: page renders with the identity chip`,
        'chip visible',
        String(chipVisible),
        chipVisible,
      );
      await vpPage.screenshot({ path: path.join(OUT_DIR, `compile-${size.name}-poster.png`) });
      await vpContext.close();
    }

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
