/**
 * KYN-05 + KYN-06 visual QA: `pnpm qa:visual`
 *
 * Builds nothing itself — expects a production build (`pnpm build`). Starts
 * the web app on a scratch port, captures every surface at the five required
 * viewports plus reduced-motion variants, and runs functional checks
 * (navigation, keyboard playhead, 3D scene truth, camera independence,
 * transport controls, 2D fallback toggle, overflow, console errors). Writes
 * PNGs under qa/ and a machine-readable report at qa/report.json. Exits
 * non-zero on any failed check.
 */
import { execSync, spawn } from 'node:child_process';
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

/** Checkpoint with known golden truth (fixture seed 24017). */
const CHECKPOINT_MS = 4722100;
/** Ball truth at the checkpoint: fixture seed 24017, exact sample. */
const BALL_AT_CHECKPOINT = { xM: 21.241, yM: -2.172, zM: 0.11 } as const;

interface CheckResult {
  route: string;
  viewport: string;
  reducedMotion: boolean;
  screenshot: string;
  horizontalOverflowPx: number;
  consoleErrors: string[];
  checks: Record<string, boolean | number | string>;
}

/**
 * QA hooks exposed by the live scene (clearly labeled debug affordances, not
 * user-facing). Shapes mirror living-replay.tsx.
 */
declare global {
  interface Window {
    __kyneloomScene?: {
      playheadMs(): number;
      snapshot(): {
        playheadMs: number;
        players: {
          entityId: string;
          xM: number;
          yM: number;
          zM: number;
          exact: boolean;
          origin: string;
        }[];
        ball: { entityId: string; xM: number; yM: number; zM: number; exact: boolean };
        missing: string[];
      };
    };
    __kyneloomPerf?: {
      fps: number;
      p50Ms: number;
      p95Ms: number;
      drawCalls: number;
      triangles: number;
      geometries: number;
      textures: number;
      samples: number;
    };
  }
}

/** Windows: PIDs still LISTENing on the port (netstat text scrape). */
function listeningPids(port: number): string[] {
  try {
    const out = execSync('netstat -ano').toString();
    return [
      ...new Set(
        out
          .split('\n')
          .filter((line) => line.includes(`:${port}`) && line.includes('LISTENING'))
          .map((line) => line.trim().split(/\s+/).at(-1))
          .filter((pid): pid is string => !!pid && pid !== '0'),
      ),
    ];
  } catch {
    return [];
  }
}

async function startServer(): Promise<() => Promise<void>> {
  // Refuse to run against a stale server that still owns the port — its
  // build may not match this checkout and every check would be meaningless.
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
    if (res.ok) throw new Error(`port ${PORT} is already serving — stop it first`);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error; // fetch failed = port free
  }
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
      // `next start` outlives the pnpm wrapper's tree on Windows — kill the
      // wrapper tree AND any process still listening on the port.
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 800));
      for (let attempt = 0; attempt < 5; attempt++) {
        const pids = listeningPids(PORT);
        if (pids.length === 0) return;
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /T /PID ${pid}`);
          } catch {
            /* already gone */
          }
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    } else {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
    }
  };
}

/**
 * Wait until the R3F canvas is sized and the scene QA hook is live (the perf
 * hook warms up separately — on SwiftShader headless it publishes honest
 * partial stats after ~8 rendered frames, which can take a while). Returns
 * the wall-clock ms from call to ready, or null when the 3D scene never came
 * up (2D fallback shows instead).
 */
async function waitSceneReady(page: import('playwright').Page): Promise<number | null> {
  const t0 = Date.now();
  try {
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('canvas');
        return (
          !!(window as { __kyneloomScene?: unknown }).__kyneloomScene &&
          !!canvas &&
          canvas.width > 300 &&
          canvas.height > 150
        );
      },
      undefined,
      { timeout: 45_000, polling: 250 },
    );
    return Date.now() - t0;
  } catch {
    return null;
  }
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
            .locator('a[href], button:not([disabled]), [role="slider"], input[type="range"]')
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
            const readyMs = await waitSceneReady(page);
            checks.scene3dReadyMs = readyMs ?? 'fallback';
            if (readyMs === null) {
              failures.push(`explore @ ${viewport.name}: 3D scene never became ready`);
            } else {
              // Authoritative truth at the checkpoint via the QA hook (the
              // engine's own sampleAt, not a screenshot claim).
              const snap = await page.evaluate(() => window.__kyneloomScene!.snapshot());
              checks.scenePlayers = snap.players.length;
              checks.sceneMissing = snap.missing.length;
              if (snap.players.length !== 22 || snap.missing.length !== 0) {
                failures.push(
                  `explore @ ${viewport.name}: expected 22 players / 0 missing, got ` +
                    `${snap.players.length}/${snap.missing.length}`,
                );
              }
            }

            // Transport controls exist and are enabled (cameras unlocked in KYN-06).
            checks.cameraRadios = await page
              .getByRole('radiogroup', { name: 'Camera' })
              .getByRole('radio')
              .count();
            checks.cameraDisabled = await page
              .locator('.stage__transport [role="radio"][disabled]')
              .count();
            if (checks.cameraRadios !== 4 || checks.cameraDisabled !== 0) {
              failures.push(
                `explore @ ${viewport.name}: camera radios ${checks.cameraRadios}, disabled ${checks.cameraDisabled}`,
              );
            }

            // Keyboard transport: slider focus + ArrowRight moves the playhead
            // (engine steps 100 ms per press), Space toggles play. The slider
            // is a native range input — read its value, not ARIA attributes.
            const rail = page.locator('.stage__slider');
            await rail.focus();
            const before = Number(await rail.inputValue());
            let moved = false;
            for (let attempt = 0; attempt < 3 && !moved; attempt++) {
              await page.keyboard.press('ArrowRight');
              await page.waitForTimeout(150);
              moved = Number(await rail.inputValue()) >= before + 100;
            }
            checks.playheadMoves = moved;
            if (!moved) failures.push(`explore @ ${viewport.name}: keyboard playhead did not move`);

            const playBtn = page.locator('.stage__play');
            await rail.focus();
            await page.keyboard.press(' ');
            await page.waitForTimeout(150);
            const pressedAfterSpace = await playBtn.getAttribute('aria-pressed');
            await page.keyboard.press(' ');
            await page.waitForTimeout(150);
            checks.spaceTogglesPlay = pressedAfterSpace === 'true';
            if (pressedAfterSpace !== 'true')
              failures.push(`explore @ ${viewport.name}: Space did not start playback`);

            // Controls must never overlap the stage surface (mobile included):
            // the transport sits below the canvas, not on top of it.
            const overlapPx = await page.evaluate(() => {
              const stage = document.querySelector('.stage__canvas')?.getBoundingClientRect();
              const transport = document
                .querySelector('.stage__transport')
                ?.getBoundingClientRect();
              if (!stage || !transport) return -1;
              const x = Math.max(
                0,
                Math.min(stage.right, transport.right) - Math.max(stage.left, transport.left),
              );
              const y = Math.max(
                0,
                Math.min(stage.bottom, transport.bottom) - Math.max(stage.top, transport.top),
              );
              return Math.round(x * y);
            });
            checks.controlsOverlapStagePx = overlapPx;
            if (overlapPx === -1) {
              failures.push(`explore @ ${viewport.name}: stage/transport rects missing`);
            } else if (overlapPx > 100) {
              failures.push(
                `explore @ ${viewport.name}: transport overlaps stage by ${overlapPx}px²`,
              );
            }

            // 2D fallback toggle on the SAME timeline: same playhead, svg view.
            const toggle = page.getByRole('button', { name: /2D view/ });
            await toggle.click();
            await page.waitForTimeout(250);
            checks.twoDFallback = await page.locator('[data-scene-fallback]').count();
            if (checks.twoDFallback !== 1) {
              failures.push(`explore @ ${viewport.name}: 2D fallback did not mount`);
            }
            await page.getByRole('button', { name: /3D view/ }).click();
            await page.waitForTimeout(250);

            // Deep 3D interaction checks run once per viewport size, not per
            // reduced-motion variant (RM adds its own screenshot above).
            if (!reducedMotion && readyMs !== null) {
              // Golden checkpoint truth through the real transport UI.
              await page.getByRole('button', { name: /Reset to checkpoint/ }).click();
              await page.waitForTimeout(400);
              const atReset = await page.evaluate(() => {
                const s = window.__kyneloomScene!.snapshot();
                return { playheadMs: s.playheadMs, ball: s.ball };
              });
              checks.resetPlayheadMs = atReset.playheadMs;
              const ballOk =
                atReset.playheadMs === CHECKPOINT_MS &&
                Math.abs(atReset.ball.xM - BALL_AT_CHECKPOINT.xM) < 0.001 &&
                Math.abs(atReset.ball.yM - BALL_AT_CHECKPOINT.yM) < 0.001 &&
                Math.abs(atReset.ball.zM - BALL_AT_CHECKPOINT.zM) < 0.001 &&
                atReset.ball.exact === true;
              checks.ballTruthAtCheckpoint = ballOk;
              if (!ballOk) {
                failures.push(
                  `explore @ ${viewport.name}: ball truth at checkpoint ${JSON.stringify(atReset)}`,
                );
              }

              // Camera independence: identical world snapshots across all four
              // camera modes at the same playhead.
              const seek = async (ms: number) => {
                await page.locator('.stage__slider').evaluate((el, value) => {
                  const input = el as HTMLInputElement;
                  input.value = String(value);
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                }, ms);
                await page.waitForTimeout(250);
              };
              await seek(4728300); // goal frame
              const snaps: string[] = [];
              for (const cam of ['Broadcast', 'Overhead', 'Follow', 'Free orbit', 'Broadcast']) {
                await page.getByRole('radio', { name: cam }).click();
                await page.waitForTimeout(350);
                snaps.push(
                  JSON.stringify(await page.evaluate(() => window.__kyneloomScene!.snapshot())),
                );
              }
              checks.cameraIndependent = snaps.every((s) => s === snaps[0])
                ? 'identical'
                : 'DIVERGED';
              if (checks.cameraIndependent !== 'identical') {
                failures.push(`explore @ ${viewport.name}: snapshots diverged across cameras`);
              }

              // Deterministic pause/seek/pause: same playhead → same pose.
              await seek(4726200);
              const seekA = await page.evaluate(() =>
                JSON.stringify(window.__kyneloomScene!.snapshot()),
              );
              await seek(4730000);
              await seek(4726200);
              const seekB = await page.evaluate(() =>
                JSON.stringify(window.__kyneloomScene!.snapshot()),
              );
              checks.seekDeterministic = seekA === seekB ? 'identical' : 'DIVERGED';
              if (seekA !== seekB) {
                failures.push(`explore @ ${viewport.name}: seek returned different poses`);
              }

              // Performance probe: play 4 s of real playback, then read the
              // fixed instrument (frame times in ms, renderer stats). Numbers
              // under SwiftShader headless are honest-but-software; the
              // GPU-representative numbers come from the headed recording run.
              await page.getByRole('radio', { name: '1×' }).click();
              await page.locator('.stage__play').click();
              await page.waitForTimeout(4000);
              await page.locator('.stage__play').click(); // pause
              // Software renderers may still be warming the 8-frame probe.
              await page
                .waitForFunction(
                  () => !!(window as { __kyneloomPerf?: unknown }).__kyneloomPerf,
                  undefined,
                  { timeout: 12_000, polling: 250 },
                )
                .catch(() => undefined);
              const perf = await page.evaluate(() => window.__kyneloomPerf ?? null);
              checks.perf = JSON.stringify(perf);
              if (
                perf === null ||
                typeof perf.fps !== 'number' ||
                perf.fps <= 0 ||
                perf.samples < 8
              ) {
                failures.push(
                  `explore @ ${viewport.name}: perf probe returned ${JSON.stringify(perf)}`,
                );
              }
              // Restore the paused checkpoint state for the final screenshot.
              await page.getByRole('button', { name: /Reset to checkpoint/ }).click();

              // Scene recovery: force a real WebGL context loss and require
              // the same-timeline 2D fallback to mount (this page stays on
              // the fallback afterwards, so this check runs last).
              const lost = await page.evaluate(() => {
                const canvas = document.querySelector('canvas');
                if (!canvas) return 'no-canvas';
                const gl =
                  (canvas.getContext('webgl2') as WebGLRenderingContext | null) ??
                  canvas.getContext('webgl');
                if (!gl) return 'no-gl';
                const ext = gl.getExtension('WEBGL_lose_context');
                if (!ext) return 'no-ext';
                ext.loseContext();
                return 'lost';
              });
              await page.waitForTimeout(700);
              const fallbackReason = await page
                .locator('[data-scene-fallback]')
                .getAttribute('data-scene-fallback');
              checks.contextLoss = `${lost} → ${fallbackReason ?? 'none'}`;
              if (lost !== 'lost' || fallbackReason !== 'context-lost') {
                failures.push(
                  `explore @ ${viewport.name}: context loss recovery ${checks.contextLoss}`,
                );
              }
            }
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
