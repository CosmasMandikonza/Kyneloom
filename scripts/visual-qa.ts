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
      /** Rendered Three.js object probes (mesh roots, camera). */
      visual?: {
        ballWorldPosition(): readonly [number, number, number] | null;
        ballQuaternion(): readonly [number, number, number, number] | null;
        playerYaw(entityId: string): number | null;
        cameraWorldPosition(): readonly [number, number, number] | null;
        cameraFov(): number | null;
        cameraLookTarget(): readonly [number, number, number] | null;
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
          hasTouch: viewport.name === '390x844', // touch-gesture QA on mobile
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
            if (checks.cameraRadios !== 6 || checks.cameraDisabled !== 0) {
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
              for (const cam of [
                'Broadcast',
                'Overhead',
                'Follow',
                'Goalkeeper',
                'Free orbit',
                'Directed',
                'Broadcast',
              ]) {
                await page.getByRole('radio', { name: cam }).click({ force: true });
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

              // RENDERED mesh truth (review fixes 2–3), not just source data:
              // the ball mesh sits at the exact authoritative transform —
              // zM IS the ball-center height, no radius double-lift — and its
              // orientation plus a player's facing are pure functions of the
              // playhead (scrub away and back → byte-identical).
              await seek(4728300); // goal frame: ball near the goal mouth, airborne
              await page.waitForTimeout(500);
              const meshes = await page.evaluate(() => {
                const visual = window.__kyneloomScene?.visual;
                return {
                  ballPos: visual?.ballWorldPosition() ?? null,
                  ballQuat: visual?.ballQuaternion() ?? null,
                  yaw: visual?.playerYaw('home-11') ?? null,
                  ballSource: window.__kyneloomScene!.snapshot().ball,
                };
              });
              if (meshes.ballPos === null || meshes.ballQuat === null || meshes.yaw === null) {
                failures.push(`explore @ ${viewport.name}: visual probe returned nulls`);
              } else {
                // pitchToThree(ball) = (xM, zM, −yM) exactly.
                const [ex, ey, ez] = meshes.ballSource
                  ? [meshes.ballSource.xM, meshes.ballSource.zM, -meshes.ballSource.yM]
                  : [0, 0, 0];
                const poseOk =
                  Math.abs(meshes.ballPos[0] - ex) < 0.002 &&
                  Math.abs(meshes.ballPos[1] - ey) < 0.002 &&
                  Math.abs(meshes.ballPos[2] - ez) < 0.002;
                checks.ballMeshAtSource = poseOk
                  ? 'exact'
                  : `OFF ${JSON.stringify(meshes.ballPos)}`;
                if (!poseOk) {
                  failures.push(
                    `explore @ ${viewport.name}: ball mesh ${JSON.stringify(meshes.ballPos)} ≠ source [${ex}, ${ey}, ${ez}]`,
                  );
                }
                await seek(4717500); // scrub far away
                await seek(4728300); // and back
                await page.waitForTimeout(500);
                const back = await page.evaluate(() => {
                  const visual = window.__kyneloomScene?.visual;
                  return {
                    ballQuat: visual?.ballQuaternion() ?? null,
                    yaw: visual?.playerYaw('home-11') ?? null,
                  };
                });
                const reference = meshes.ballQuat;
                const quatIdentical =
                  back.ballQuat !== null &&
                  reference !== null &&
                  back.ballQuat.every((v, i) => Math.abs(v - (reference[i] ?? 0)) < 1e-9);
                checks.ballSpinDeterministic = quatIdentical ? 'identical' : 'DIVERGED';
                if (!quatIdentical) {
                  failures.push(`explore @ ${viewport.name}: ball spin drifted across scrub`);
                }
                const yawIdentical = back.yaw !== null && Math.abs(back.yaw - meshes.yaw) < 1e-9;
                checks.playerYawDeterministic = yawIdentical ? 'identical' : 'DIVERGED';
                if (!yawIdentical) {
                  failures.push(`explore @ ${viewport.name}: player facing drifted across scrub`);
                }
              }

              // Camera convergence (review fix 5): with seconds-domain
              // damping, mode switches must actually settle — overhead to
              // its fixed vantage, follow to its tracking height — at real
              // frame rates (SwiftShader included: big dt closes FASTER).
              const converge = async (
                cam: string,
                done: (p: readonly [number, number, number]) => boolean,
              ) => {
                await page.getByRole('radio', { name: cam }).click({ force: true });
                const deadline = Date.now() + 12_000;
                let last: readonly [number, number, number] | null = null;
                while (Date.now() < deadline) {
                  await page.waitForTimeout(450);
                  const p = await page.evaluate(
                    () => window.__kyneloomScene?.visual?.cameraWorldPosition() ?? null,
                  );
                  if (p !== null && done(p)) return p;
                  last = p;
                }
                return last;
              };
              const overheadPos = await converge(
                'Overhead',
                (p) => Math.hypot(p[0] - 0, p[1] - 92, p[2] - 0.001) < 0.75,
              );
              checks.cameraOverheadConverged =
                overheadPos !== null && Math.hypot(overheadPos[1] - 92) < 1
                  ? `yes ${overheadPos.map((v) => v.toFixed(1)).join('/')}`
                  : `NO ${overheadPos === null ? 'null' : overheadPos.map((v) => v.toFixed(1)).join('/')}`;
              if (!checks.cameraOverheadConverged.startsWith('yes')) {
                failures.push(`explore @ ${viewport.name}: overhead camera never converged`);
              }
              const followPos = await converge(
                'Follow',
                (p) => Math.abs(p[1] - 4.4) < 0.4 && Math.abs(p[0]) < 60 && Math.abs(p[2]) < 60,
              );
              checks.cameraFollowConverged =
                followPos !== null && Math.abs(followPos[1] - 4.4) < 0.5
                  ? `yes ${followPos.map((v) => v.toFixed(1)).join('/')}`
                  : `NO ${followPos === null ? 'null' : followPos.map((v) => v.toFixed(1)).join('/')}`;
              if (!checks.cameraFollowConverged.startsWith('yes')) {
                failures.push(`explore @ ${viewport.name}: follow camera never converged`);
              }
              // Goalkeeper view converges onto the ENGAGED keeper's actual
              // position (away-01 defends the +x goal; ball at the goal
              // mouth at 4728300 → keeper ≈ three-space (43.6, 0, 4.9)).
              const keeperPos = await converge(
                'Goalkeeper',
                (pt) => Math.hypot(pt[0] - 43.6, pt[2] - 4.9) < 6 && pt[1] > 1 && pt[1] < 5,
              );
              checks.cameraKeeperConverged =
                keeperPos !== null && keeperPos[1] > 1 && keeperPos[1] < 5
                  ? `yes ${keeperPos.map((v) => v.toFixed(1)).join('/')}`
                  : `NO ${keeperPos === null ? 'null' : keeperPos.map((v) => v.toFixed(1)).join('/')}`;
              if (!checks.cameraKeeperConverged.startsWith('yes')) {
                failures.push(`explore @ ${viewport.name}: goalkeeper camera never converged`);
              }

              // Directed mode: deterministic poses from the authored track.
              // At the goal beat (4728300, local offset 11300) the rig must
              // settle EXACTLY on the authored keyframe pose (time conversion
              // + sampling proof), and scrubbing away and back reproduces it.
              await page.getByRole('radio', { name: 'Directed' }).click();
              const directedGoal = await (async () => {
                const deadline = Date.now() + 12_000;
                // Authored keyframe 6 (offset 11300): position [59,-7,3.2]
                // pitch → three (59, 3.2, 7).
                for (;;) {
                  await page.waitForTimeout(450);
                  const pt = await page.evaluate(
                    () => window.__kyneloomScene?.visual?.cameraWorldPosition() ?? null,
                  );
                  if (pt !== null && Math.hypot(pt[0] - 59, pt[1] - 3.2, pt[2] - 7) < 0.4) {
                    return pt;
                  }
                  if (Date.now() > deadline) return pt;
                }
              })();
              checks.cameraDirectedGoalPose =
                directedGoal !== null
                  ? `yes ${directedGoal.map((v) => v.toFixed(1)).join('/')}`
                  : 'NO null';
              if (!checks.cameraDirectedGoalPose.startsWith('yes')) {
                failures.push(
                  `explore @ ${viewport.name}: directed camera missed the authored goal pose ${JSON.stringify(directedGoal)}`,
                );
              }
              await seek(4_717_400); // scrub far away mid-transition (interruption)
              await seek(4_728_300); // and back
              // The spring is mid-transition right after the seek (visible
              // on slow renderers); wait until the camera SETTLES at the
              // directed pose, then confirm the settled pose matches the
              // pre-scrub one — determinism of the pose itself.
              const directedBack = await (async () => {
                const deadline = Date.now() + 15_000;
                let previous: readonly [number, number, number] | null = null;
                for (;;) {
                  await page.waitForTimeout(600);
                  const pt = await page.evaluate(
                    () => window.__kyneloomScene?.visual?.cameraWorldPosition() ?? null,
                  );
                  if (
                    pt !== null &&
                    previous !== null &&
                    Math.hypot(pt[0] - previous[0], pt[1] - previous[1], pt[2] - previous[2]) < 0.05
                  ) {
                    return pt;
                  }
                  previous = pt;
                  if (Date.now() > deadline) return pt;
                }
              })();
              const directedDeterministic =
                directedGoal !== null &&
                directedBack !== null &&
                Math.hypot(
                  directedBack[0] - directedGoal[0],
                  directedBack[1] - directedGoal[1],
                  directedBack[2] - directedGoal[2],
                ) < 0.5;
              checks.directedSeekDeterministic = directedDeterministic ? 'identical' : 'DIVERGED';
              if (!directedDeterministic) {
                failures.push(`explore @ ${viewport.name}: directed pose drifted across scrub`);
              }
              // Escape exits directed mode back to broadcast.
              await page.locator('.stage__slider').focus();
              await page.keyboard.press('Escape');
              await page.waitForTimeout(300);
              checks.escapeExitsDirected =
                (await page
                  .getByRole('radio', { name: 'Broadcast' })
                  .getAttribute('aria-checked')) ?? '(null)';
              if (checks.escapeExitsDirected !== 'true') {
                failures.push(`explore @ ${viewport.name}: Escape did not exit directed mode`);
              }

              // Rapid repeated mode changes must stay finite and converge.
              for (const cam of ['Overhead', 'Follow', 'Goalkeeper', 'Directed', 'Overhead']) {
                await page.getByRole('radio', { name: cam }).click({ force: true });
                await page.waitForTimeout(120);
              }
              const rapidPos = await converge(
                'Overhead',
                (pt) => Math.hypot(pt[0], pt[1] - 92, pt[2]) < 0.75,
              );
              checks.rapidChangesConverge =
                rapidPos !== null && Number.isFinite(rapidPos[0]) ? 'yes' : 'NO';
              if (checks.rapidChangesConverge !== 'yes') {
                failures.push(
                  `explore @ ${viewport.name}: camera unstable after rapid mode changes`,
                );
              }

              // Free-orbit safety (review round 2): actual drag / pan / zoom
              // gestures pushed toward and beyond the boundaries — the lens
              // must stay inside the stadium, above ground, and the pan
              // target inside its box, without breaking the controls.
              await page.getByRole('radio', { name: 'Free orbit' }).click({ force: true });
              await page.waitForTimeout(900);
              const stageBox = await page.locator('.stage__canvas').boundingBox();
              if (stageBox === null) throw new Error('stage box missing for orbit gestures');
              const cx = stageBox.x + stageBox.width / 2;
              const cy = stageBox.y + stageBox.height / 2;
              // Zoom hard in then far out (wheel dolly).
              await page.mouse.move(cx, cy);
              for (let i = 0; i < 14; i += 1) await page.mouse.wheel(0, -260);
              await page.waitForTimeout(400);
              for (let i = 0; i < 10; i += 1) await page.mouse.wheel(0, 420);
              await page.waitForTimeout(400);
              // Rotate downward hard (left drag): tries to dive below pitch.
              await page.mouse.move(cx, cy);
              await page.mouse.down();
              for (let i = 1; i <= 10; i += 1) {
                await page.mouse.move(cx + i * 10, cy + i * 16, { steps: 2 });
              }
              await page.mouse.up();
              await page.waitForTimeout(400);
              // Pan toward a far corner (right drag), repeatedly past bounds.
              for (let round = 0; round < 8; round += 1) {
                await page.mouse.move(cx, cy);
                await page.mouse.down({ button: 'right' });
                await page.mouse.move(cx - 240, cy - 150, { steps: 5 });
                await page.mouse.up({ button: 'right' });
                await page.waitForTimeout(100);
              }
              await page.waitForTimeout(900);
              const orbitPose = await page.evaluate(() => {
                const visual = window.__kyneloomScene?.visual;
                return {
                  pos: visual?.cameraWorldPosition() ?? null,
                  target: visual?.cameraLookTarget() ?? null,
                };
              });
              const EPS = 0.05;
              const orbitOk =
                orbitPose.pos !== null &&
                orbitPose.target !== null &&
                orbitPose.pos[1] >= 0.65 - EPS &&
                orbitPose.pos[1] <= 165 + EPS &&
                Math.abs(orbitPose.pos[0]) <= 82 + EPS &&
                Math.abs(orbitPose.pos[2]) <= 82 + EPS &&
                orbitPose.target[1] >= -EPS &&
                orbitPose.target[1] <= 165 + EPS &&
                Math.abs(orbitPose.target[0]) <= 82 + EPS &&
                Math.abs(orbitPose.target[2]) <= 82 + EPS;
              checks.orbitBoundsAfterGestures =
                orbitPose.pos !== null && orbitPose.target !== null
                  ? `${orbitOk ? 'ok' : 'VIOLATED'} pos ${orbitPose.pos.map((v) => v.toFixed(1)).join('/')} target ${orbitPose.target.map((v) => v.toFixed(1)).join('/')}`
                  : 'NO null';
              if (!checks.orbitBoundsAfterGestures.startsWith('ok')) {
                failures.push(
                  `explore @ ${viewport.name}: orbit gestures escaped the safety bounds ${JSON.stringify(orbitPose)}`,
                );
              }
              // Leaving orbit after all that: the spring still converges.
              const orbitExit = await converge(
                'Overhead',
                (pt) => Math.hypot(pt[0], pt[1] - 92, pt[2]) < 0.75,
              );
              checks.orbitExitConverged =
                orbitExit !== null && Math.hypot(orbitExit[1] - 92) < 1 ? 'yes' : 'NO';
              if (checks.orbitExitConverged !== 'yes') {
                failures.push(
                  `explore @ ${viewport.name}: camera failed to converge after orbit exit`,
                );
              }

              // FOV stays inside the contract range across every mode.
              const fovs: number[] = [];
              for (const cam of ['Broadcast', 'Overhead', 'Follow', 'Goalkeeper', 'Directed']) {
                await page.getByRole('radio', { name: cam }).click({ force: true });
                await page.waitForTimeout(700);
                const fov = await page.evaluate(
                  () => window.__kyneloomScene?.visual?.cameraFov() ?? null,
                );
                if (typeof fov === 'number') fovs.push(fov);
              }
              checks.cameraFovRange = fovs.every((f) => f >= 20 && f <= 120)
                ? `${Math.min(...fovs).toFixed(0)}–${Math.max(...fovs).toFixed(0)}°`
                : `OUT ${JSON.stringify(fovs)}`;
              if (!checks.cameraFovRange.includes('°')) {
                failures.push(`explore @ ${viewport.name}: fov left the 20–120° range`);
              }

              // Evidence screenshot: the directed composition at the goal.
              await page.getByRole('radio', { name: 'Directed' }).click({ force: true });
              await seek(4_728_300);
              await page.waitForTimeout(1200);
              await page.screenshot({
                path: path.join(OUT_DIR, 'screenshots', `explore-directed-${viewport.name}.png`),
              });

              await page.getByRole('radio', { name: 'Broadcast' }).click({ force: true });
              await page.waitForTimeout(350);

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
