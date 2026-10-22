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
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  { name: 'moments', path: '/moments' },
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
        projectWorld?(x: number, y: number, z: number): readonly [number, number] | null;
      };
    };
    __kyneloomLanding?: {
      state(): string;
      fragmentCount(): number;
      markerCount(): number;
    };
    __kyneloomLiveProbe?: {
      status(): string;
      stateVersion(): string | null;
      seq(): number;
      trackingCount(): number;
      matchTimeMs(): number;
    };
    __kyneloomLandingHold?: boolean;
    __kyneloomLandingPerf?: {
      fps: number;
      p50Ms: number;
      p95Ms: number;
      drawCalls: number;
      triangles: number;
      geometries: number;
      textures: number;
      samples: number;
    };
    __kyneloomXray?: {
      active(): boolean;
      phase(): 'before' | 'after' | 'both' | null;
      visibleLineCount(): number;
      labelVisible(): boolean;
      hitTargetsScreen(): { x: number; y: number }[];
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
    __kyneloomMoments?: {
      count(): number;
      ids(): string[];
      focusMs(): number[];
      previewStatuses(): Record<string, string>;
      motionActive(): boolean;
      activeTiltLoops(): number;
      reducedMotion(): boolean;
    };
    __kyneloomLens?: {
      lens(): string;
      playheadMs(): number;
      selected(): string | null;
      camera(): string;
      view(): string;
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
 * WebGL-bearing evidence capture with ONE retry: this host's software
 * renderer can stall a canvas readback past the screenshot timeout (the
 * documented SwiftShader wedge). A single retry after the stall usually
 * succeeds; a second failure is RECORDED as a run failure — never a silent
 * skip — and the matrix continues so the remaining evidence still lands.
 */
async function evidenceShot(
  page: import('playwright').Page,
  file: string,
  failures: string[],
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.screenshot({
        path: path.join(OUT_DIR, 'screenshots', file),
        timeout: attempt === 1 ? 30_000 : 60_000,
      });
      return;
    } catch (error) {
      if (attempt === 2) {
        failures.push(`screenshot ${file} failed twice: ${String(error).slice(0, 90)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
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

/**
 * KYN-09 desktop landing transition, extracted so it can be retried on a
 * fresh page: capturing the WebGL canvas mid-flight can wedge this host's
 * software renderer (synchronous readback stall — see the mobile note in
 * main). A fresh page means a fresh renderer process; the retry runs the
 * identical assertions, never a silent pass.
 */
async function runLandingDesktopTransition(
  page: import('playwright').Page,
  viewportName: string,
  checks: Record<string, boolean | number | string>,
  failures: string[],
): Promise<void> {
  // KYN-09 — the orb→stadium transition, exercised end to end at
  // the three desktop viewports (full choreography + skip + rapid
  // double-click). Mobile (390/375) keeps the idle/budget/CTA
  // checks plus the reduced-motion direct handoff: the mid-flight
  // canvas screenshot can wedge this host's software renderer for
  // minutes (synchronous readback stall), and the transition
  // logic is viewport-independent — KYN-09's committed
  // i3-mobile-* captures remain the mobile visual evidence.
  const flowStart = Date.now();
  // The idle phase is traced from inside the canvas render loop; on a slow
  // (or retried) page the first frame can land AFTER this point, which would
  // start the recorded history at 'intro'. Wait for the trace's idle entry
  // before starting the machine — first attempt and retry alike.
  await page.waitForFunction(
    () => {
      try {
        const parsed = JSON.parse(
          window.sessionStorage.getItem('kyneloom.landing.phases') ?? '{"phases":[]}',
        ) as { phases?: string[] };
        return (parsed.phases ?? [])[0] === 'idle';
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 45_000, polling: 250 },
  );
  // Hold the READY handoff (the landing honors
  // __kyneloomLandingHold) so the reveal capture cannot race the
  // hard navigation on slow renderers.
  await page.evaluate(() => {
    (window as { __kyneloomLandingHold?: boolean }).__kyneloomLandingHold = true;
  });
  await page.getByTestId('enter-the-moment').click();
  if (viewportName === '1024x768') {
    // Acceptance 6: rapid repeated clicks — a second activation
    // while the transition runs must never duplicate it.
    await page
      .getByTestId('enter-the-moment')
      .click({ force: true, noWaitAfter: true })
      .catch(() => undefined);
  }
  if (viewportName === '1280x800') {
    // Acceptance 7: Skip during the intro phase. Release the hold
    // FIRST — the skip path has no reveal capture, and waiting for
    // /explore before the release would deadlock on the hold.
    await page.waitForTimeout(300);
    await page.getByTestId('skip-intro').click();
    await page.evaluate(() => {
      (window as { __kyneloomLandingHold?: boolean }).__kyneloomLandingHold = false;
    });
    await page.waitForFunction(() => window.location.pathname === '/explore', undefined, {
      timeout: 60_000,
      polling: 250,
    });
    checks.landingSkip = 'yes';
  } else {
    // Fragment + reveal captures by elapsed time (the FSM budgets
    // are wall-clock deterministic; slow renderers cannot skip).
    // Screenshots only at 1440x900: capturing a WebGL frame
    // mid-flight can stall this host's software renderer (one
    // retry allowed below); flow assertions run everywhere.
    const captureShots = viewportName === '1440x900';
    await page.waitForTimeout(2050);
    if (captureShots) {
      await page.screenshot({
        path: path.join(OUT_DIR, 'screenshots', `landing-fragments-${viewportName}.png`),
      });
    }
    await page.waitForFunction(
      () =>
        (window as { __kyneloomLanding?: { state(): string } }).__kyneloomLanding?.state() ===
          'pitch_reveal' || window.location.pathname === '/explore',
      undefined,
      { timeout: 60_000, polling: 250 },
    );
    await page.waitForTimeout(900);
    if (captureShots) {
      await page.screenshot({
        path: path.join(OUT_DIR, 'screenshots', `landing-reveal-${viewportName}.png`),
      });
    }
  }
  await page.evaluate(() => {
    (window as { __kyneloomLandingHold?: boolean }).__kyneloomLandingHold = false;
  });
  await page.waitForFunction(() => window.location.pathname === '/explore', undefined, {
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
    undefined,
    { timeout: 45_000 },
  );
  await page.waitForTimeout(1800); // handoff settle + broadcast sweep
  const ready = await page.evaluate(() => ({
    playhead: window.__kyneloomScene?.playheadMs?.() ?? null,
    players: window.__kyneloomScene?.snapshot?.().players.length ?? null,
    landingGone: (window as { __kyneloomLanding?: unknown }).__kyneloomLanding === undefined,
    canvases: document.querySelectorAll('canvas').length,
  }));
  // Phase-state evidence (review gates 1 + 2), surviving the SPA
  // navigation via sessionStorage: the exact phases this entry
  // passed through, and that rapid activation started once.
  const trace = await page.evaluate(() => {
    try {
      return JSON.parse(
        window.sessionStorage.getItem('kyneloom.landing.phases') ?? '{"phases":[],"startCount":-1}',
      ) as { phases?: string[]; startCount?: number };
    } catch {
      return { phases: [], startCount: -1 };
    }
  });
  checks.landingHandoff = JSON.stringify({
    ...ready,
    phases: trace.phases,
    startCount: trace.startCount,
    ms: Date.now() - flowStart,
  });
  if (viewportName === '1440x900') {
    // The full choreography, in order, exactly once each.
    const expected = ['idle', 'intro', 'fragments', 'pitch_reveal', 'ready'];
    const got = trace.phases ?? [];
    const orderedOk =
      expected.every((phase) => got.includes(phase)) &&
      expected.every(
        (phase, i) =>
          got.indexOf(phase) !== -1 &&
          (i === 0 ||
            got.indexOf(expected[i - 1]!) === -1 ||
            got.indexOf(expected[i - 1]!) < got.indexOf(phase)),
      );
    if (!orderedOk) {
      failures.push(
        `landing @ ${viewportName}: phase history ${JSON.stringify(got)} missing the ordered five states`,
      );
    }
  }
  if (viewportName === '1024x768') {
    // Review gate 2: the double activation started the machine
    // exactly once and the intended navigation kept enter=orb.
    if (trace.startCount !== 1) {
      failures.push(
        `landing @ ${viewportName}: rapid double-click startCount ${String(trace.startCount)} != 1`,
      );
    }
    if (!page.url().includes('enter=orb')) {
      failures.push(
        `landing @ ${viewportName}: completed transition lost ?enter=orb (${page.url()})`,
      );
    }
  }
  // Acceptance 4: the canonical checkpoint survives the handoff.
  if (ready.playhead !== 4_722_100) {
    failures.push(
      `landing @ ${viewportName}: playhead ${String(ready.playhead)} != checkpoint 4722100`,
    );
  }
  if (ready.players !== 22) {
    failures.push(`landing @ ${viewportName}: ${String(ready.players)} players after handoff`);
  }
  if (!ready.landingGone) {
    failures.push(`landing @ ${viewportName}: landing probe retained after handoff`);
  }
  if (ready.canvases !== 1) {
    failures.push(
      `landing @ ${viewportName}: ${String(ready.canvases)} canvases after handoff (expected 1)`,
    );
  }

  // Acceptance 10: repeated landing → replay → back → replay stays
  // resource-stable (no retained loop, bounded GPU growth).
  if (viewportName === '1440x900') {
    const first = await page.evaluate(() => ({
      g: window.__kyneloomPerf?.geometries ?? -1,
      t: window.__kyneloomPerf?.textures ?? -1,
    }));
    await page.goBack();
    await page.waitForFunction(
      () => (window as { __kyneloomLanding?: unknown }).__kyneloomLanding !== undefined,
      undefined,
      { timeout: 30_000 },
    );
    await page.getByTestId('enter-the-moment').click();
    await page.waitForFunction(
      () =>
        window.location.pathname === '/explore' &&
        (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
      undefined,
      { timeout: 45_000 },
    );
    await page.waitForTimeout(1500);
    const second = await page.evaluate(() => ({
      g: window.__kyneloomPerf?.geometries ?? -1,
      t: window.__kyneloomPerf?.textures ?? -1,
    }));
    const dg = second.g - first.g;
    const dt = second.t - first.t;
    checks.landingRepeatNav = `ok (Δgeo +${String(dg)}, Δtex +${String(dt)})`;
    if (dg > 3 || dt > 3) {
      failures.push(
        `landing @ ${viewportName}: repeated navigation leaked GPU resources (Δgeo +${String(dg)}, Δtex +${String(dt)})`,
      );
    }
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
        // Reduced-motion variants cover the scene-bearing surfaces plus the
        // gallery at mobile + one desktop width (documented in qa/README.md).
        if (reducedMotion && !['390x844', '1440x900'].includes(viewport.name)) continue;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
          deviceScaleFactor: 1,
          hasTouch: viewport.name === '390x844', // touch-gesture QA on mobile
        });
        let page = await context.newPage();
        for (const route of ROUTES) {
          if (reducedMotion && !['landing', 'explore', 'moments'].includes(route.name)) continue;
          const consoleErrors: string[] = [];
          page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
          });
          await page.goto(BASE + route.path, { waitUntil: 'networkidle', timeout: 90_000 });
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
            // KYN-09 — the encounter contract: headline, ONE primary CTA
            // that is actually clickable (no invisible pointer-capturing
            // surface above it), the real fixture facts, and a live orb.
            const cta = page.getByTestId('enter-the-moment').first();
            checks.ctaText = (await cta.innerText()).trim();
            const ctaBox = await cta.boundingBox();
            const ctaClickable =
              ctaBox === null
                ? false
                : await page.evaluate(
                    (pt) => {
                      const el = document.elementFromPoint(pt.x, pt.y);
                      return (
                        el !== null &&
                        (el as HTMLElement).closest('[data-testid="enter-the-moment"]') !== null
                      );
                    },
                    { x: ctaBox.x + ctaBox.width / 2, y: ctaBox.y + ctaBox.height / 2 },
                  );
            checks.ctaClickable = ctaClickable ? 'yes' : 'BLOCKED';
            if (!ctaClickable) {
              failures.push(`landing @ ${viewport.name}: CTA is not the top element at its point`);
            }
            checks.fixtureSamplesShown = await page
              .locator('.landing__facts dd')
              .nth(2)
              .innerText();
            if (!reducedMotion) {
              await page.waitForFunction(
                () => (window as { __kyneloomLanding?: unknown }).__kyneloomLanding !== undefined,
                undefined,
                { timeout: 20_000 },
              );
              const landing = await page.evaluate(() =>
                JSON.stringify({
                  state: window.__kyneloomLanding?.state() ?? null,
                  fragments: window.__kyneloomLanding?.fragmentCount() ?? null,
                  markers: window.__kyneloomLanding?.markerCount() ?? null,
                }),
              );
              checks.landingOrb = landing;
              if (!landing.includes('"state":"idle"')) {
                failures.push(`landing @ ${viewport.name}: orb probe not idle: ${landing}`);
              }
              // Review gate 4: phone widths (fine OR coarse pointer) must
              // get the mobile fragment budget; desktop the full field.
              const expectedFragments =
                viewport.name === '390x844' || viewport.name === '375x812' ? 320 : 900;
              if (!landing.includes(`"fragments":${String(expectedFragments)}`)) {
                failures.push(
                  `landing @ ${viewport.name}: fragment budget ${landing} != expected ${String(expectedFragments)}`,
                );
              }
            }
          }
          if (route.name === 'landing' && !reducedMotion && viewport.width >= 1024) {
            // One bounded fresh-page retry (see runLandingDesktopTransition):
            // a wedged SwiftShader renderer cannot even process a reload, so
            // the retry gets a new page — new renderer process — and reruns
            // the full transition with the same assertions.
            try {
              await runLandingDesktopTransition(page, viewport.name, checks, failures);
            } catch (error) {
              if (!(error instanceof Error) || !error.message.includes('Timeout')) {
                throw error;
              }
              const retryPage = await context.newPage();
              retryPage.on('console', (msg) => {
                if (msg.type() === 'error') consoleErrors.push(msg.text());
              });
              await retryPage.goto(BASE + route.path, {
                waitUntil: 'networkidle',
                timeout: 90_000,
              });
              await page.close().catch(() => undefined);
              page = retryPage;
              await runLandingDesktopTransition(page, viewport.name, checks, failures);
            }
          }

          if (route.name === 'landing' && reducedMotion && viewport.name === '390x844') {
            // Acceptance 8: reduced motion leads straight to the replay.
            const t0 = Date.now();
            await page.getByTestId('enter-the-moment').click();
            await page.waitForFunction(() => window.location.pathname === '/explore', undefined, {
              timeout: 25_000,
            });
            // Review gate 1: PHASE assertion, not just navigation — the
            // machine went idle → ready and never entered choreography.
            const rmTrace = await page.evaluate(() => {
              try {
                return JSON.parse(
                  window.sessionStorage.getItem('kyneloom.landing.phases') ?? '{"phases":[]}',
                ) as { phases?: string[] };
              } catch {
                return { phases: [] };
              }
            });
            checks.landingReducedMotion = `direct handoff in ${String(Date.now() - t0)}ms; phases ${JSON.stringify(rmTrace.phases)}`;
            const rmPhases = rmTrace.phases ?? [];
            if (
              rmPhases.length !== 2 ||
              rmPhases[0] !== 'idle' ||
              rmPhases[1] !== 'ready' ||
              rmPhases.includes('intro') ||
              rmPhases.includes('fragments') ||
              rmPhases.includes('pitch_reveal')
            ) {
              failures.push(
                `landing reduced-motion: phases ${JSON.stringify(rmPhases)} != ['idle','ready']`,
              );
            }
            await page.waitForFunction(
              () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
              undefined,
              { timeout: 45_000 },
            );
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

            // KYN-11 — lens perspectives: Fan is the default chrome; lens
            // switching preserves the football truth EXACTLY (playhead,
            // selection, world snapshot); the presentations render distinct
            // chrome; preference persists per session and malformed values
            // revert to Fan; a remembered lens never overrides a gallery
            // chapter's own timestamp.
            {
              const fanRadio = page.getByRole('radio', { name: 'Fan', exact: true });
              const fanChecked = await fanRadio.getAttribute('aria-checked');
              const explainPresent = (await page.getByTestId('fan-explain').count()) === 1;
              const fanCameraGroups = await page
                .getByRole('radiogroup', { name: 'Camera' })
                .count();
              checks.lensFanDefault =
                fanChecked === 'true' && explainPresent && fanCameraGroups === 0;
              if (!checks.lensFanDefault) {
                failures.push(
                  `explore @ ${viewport.name}: fan default broken (checked ${String(fanChecked)}, explain ${String(explainPresent)}, camera groups ${String(fanCameraGroups)})`,
                );
              }

              // Truth invariance across every lens switch.
              const stateBefore = await page.evaluate(() => ({
                lens: window.__kyneloomLens!.lens(),
                playhead: window.__kyneloomLens!.playheadMs(),
                selected: window.__kyneloomLens!.selected(),
                world: JSON.stringify(window.__kyneloomScene!.snapshot()),
              }));
              const lensStates: string[] = [];
              for (const next of ['Analyst', 'Accessible', 'Fan', 'Analyst'] as const) {
                await page.getByRole('radio', { name: next, exact: true }).click({ force: true });
                await page.waitForTimeout(450);
                lensStates.push(
                  JSON.stringify(
                    await page.evaluate(() => ({
                      playhead: window.__kyneloomLens!.playheadMs(),
                      selected: window.__kyneloomLens!.selected(),
                      world: JSON.stringify(window.__kyneloomScene!.snapshot()),
                    })),
                  ),
                );
              }
              const truthInvariant = lensStates.every(
                (state) =>
                  JSON.parse(state).playhead === stateBefore.playhead &&
                  JSON.parse(state).selected === stateBefore.selected &&
                  JSON.parse(state).world === stateBefore.world,
              );
              checks.lensTruthInvariant = truthInvariant ? 'identical' : 'DIVERGED';
              if (!truthInvariant) {
                failures.push(`explore @ ${viewport.name}: lens switching changed football truth`);
              }

              // Presentation chrome actually differs per lens.
              const analystChrome = (await page.getByTestId('analyst-rail').count()) === 1;
              const analystMeasure = await page
                .getByTestId('rail-measure')
                .innerText()
                .catch(() => '');
              checks.lensAnalystChrome =
                analystChrome && analystMeasure.includes('14.038') ? 'rail+metric' : 'MISSING';
              // Review round: projected player selection keeps the rail's
              // semantic facts list intact while the live leaf updates.
              const selectionClick = await page.evaluate(() => {
                const canvas = document.querySelector('canvas');
                const scene = window.__kyneloomScene;
                if (canvas === null || scene === undefined) return null;
                const snap = scene.snapshot();
                const project = scene.visual?.projectWorld;
                if (project === undefined) return null;
                const box = canvas.getBoundingClientRect();
                // Prefer the story winger; on narrow viewports her projection
                // can sit under the rail overlay, so fall back to any player
                // whose projected point is actually the top element (a real,
                // unobstructed tap target — same discipline as the X-Ray
                // click-target selection).
                const ordered = [
                  ...snap.players.filter((q) => q.entityId === 'home-11'),
                  ...snap.players.filter((q) => q.entityId !== 'home-11'),
                ];
                for (const player of ordered) {
                  const screen = project(player.xM, player.zM, -player.yM);
                  if (screen === null) continue;
                  const px = box.left + screen[0];
                  const py = box.top + screen[1];
                  if (px < box.left || px > box.right || py < box.top || py > box.bottom) continue;
                  if (document.elementFromPoint(px, py) !== canvas) continue;
                  return { x: px, y: py, id: player.entityId };
                }
                return null;
              });
              if (selectionClick === null) {
                failures.push(`explore @ ${viewport.name}: projected selection target unavailable`);
              } else {
                await page.mouse.click(selectionClick.x, selectionClick.y);
                await page
                  .waitForFunction(
                    () =>
                      window.__kyneloomLens!.selected() === (selectionClick as { id: string }).id,
                    undefined,
                    { timeout: 5000 },
                  )
                  .catch(() => undefined);
                const selectedId = await page.evaluate(() => window.__kyneloomLens!.selected());
                checks.lensProjectedSelection = `${selectedId ?? 'none'} via ${selectionClick.id}`;
                if (selectedId !== selectionClick.id) {
                  failures.push(
                    `explore @ ${viewport.name}: projected click selected ${String(selectedId)} (wanted ${selectionClick.id})`,
                  );
                }
                await page.waitForTimeout(900); // let the 250 ms rail sync run
                const factsIntegrity = await page.evaluate(() => {
                  const dl = document.querySelector('.rail__facts');
                  if (dl === null) return { dts: -1, dds: -1, detail: '' };
                  return {
                    dts: dl.querySelectorAll('dt').length,
                    dds: dl.querySelectorAll('dd').length,
                    detail:
                      dl.querySelector('[data-testid="rail-selected-detail"]')?.textContent ?? '',
                  };
                });
                checks.lensRailFactsIntegrity = JSON.stringify(factsIntegrity);
                if (
                  factsIntegrity.dts !== 2 ||
                  factsIntegrity.dds !== 2 ||
                  !factsIntegrity.detail.includes(selectionClick.id)
                ) {
                  failures.push(
                    `explore @ ${viewport.name}: rail facts structure damaged ${checks.lensRailFactsIntegrity}`,
                  );
                }
              }
              await page
                .getByRole('radio', { name: 'Accessible', exact: true })
                .click({ force: true });
              await page.waitForTimeout(900);
              // The projected click can land under the analyst rail; if it
              // happened to hit 'Source evidence' the inspector is open and
              // would cover the accessible panel — close it first.
              const closeInspector = page.getByRole('button', { name: 'Close inspector' });
              if ((await closeInspector.count()) === 1) {
                await closeInspector.click();
                await page.waitForTimeout(300);
              }
              const transcriptText = await page
                .getByTestId('transcript')
                .innerText()
                .catch(() => '');
              const descriptionText = await page
                .getByTestId('spatial-description')
                .innerText()
                .catch(() => '');
              checks.lensAccessibleChrome =
                (await page.getByTestId('accessible-panel').count()) === 1 &&
                transcriptText.includes('evt-0007') &&
                transcriptText.includes('INTERPRETATION')
                  ? 'panel+transcript'
                  : 'MISSING';
              checks.lensDescriptionSynced = descriptionText.includes('78:4')
                ? 'live'
                : `UNSYNCED "${descriptionText.slice(0, 40)}"`;
              if (!checks.lensDescriptionSynced.startsWith('live')) {
                failures.push(
                  `explore @ ${viewport.name}: accessible description not synced (${checks.lensDescriptionSynced})`,
                );
              }
              // Review round: description is readable-NOT-live; the concise
              // announcement channel is separate, throttled and bounded
              // under advancing playback.
              const liveArchitecture = await page.evaluate(() => {
                const description = document.querySelector('[data-testid="spatial-description"]');
                const live = document.querySelector('[data-testid="live-announcement"]');
                return {
                  descAriaLive: description?.getAttribute('aria-live') ?? 'none',
                  liveRole: live?.getAttribute('role') ?? 'none',
                  count: Number(live?.getAttribute('data-count') ?? '0'),
                };
              });
              checks.lensA11yLiveArchitecture = JSON.stringify(liveArchitecture);
              if (
                liveArchitecture.descAriaLive !== 'none' ||
                liveArchitecture.liveRole !== 'status'
              ) {
                failures.push(
                  `explore @ ${viewport.name}: live-region architecture wrong ${checks.lensA11yLiveArchitecture}`,
                );
              }
              // Advancing playback: description refreshes, announcements stay bounded.
              const sliderEl = page.locator('.stage__slider');
              // Seek NEAR THE WINDOW START: earlier transport checks can
              // leave playback at 2×, and a short runway auto-stops at the
              // window end before the Pause assertion below — flipping the
              // button back to "Play" and failing the check spuriously.
              await sliderEl.evaluate((el, value) => {
                const input = el as HTMLInputElement;
                input.value = String(value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }, 4_717_400);
              const panelPlay = page
                .getByTestId('accessible-panel')
                .getByRole('button', { name: 'Play' });
              await panelPlay.click();
              const bounded = (await page.evaluate(() => {
                return new Promise((resolve) => {
                  const description = document.querySelector('[data-testid="spatial-description"]');
                  const live = document.querySelector('[data-testid="live-announcement"]');
                  const startPlayhead = description?.getAttribute('data-playhead') ?? '';
                  const startCount = Number(live?.getAttribute('data-count') ?? '0');
                  setTimeout(() => {
                    resolve({
                      playheadMoved:
                        (description?.getAttribute('data-playhead') ?? '') !== startPlayhead,
                      announcements: Number(live?.getAttribute('data-count') ?? '0') - startCount,
                      text: live?.textContent ?? '',
                    });
                  }, 2400);
                });
              })) as { playheadMoved: boolean; announcements: number; text: string };
              await page
                .getByTestId('accessible-panel')
                .getByRole('button', { name: 'Pause' })
                .click();
              checks.lensA11yBoundedAnnouncements = JSON.stringify(bounded);
              if (!bounded.playheadMoved || bounded.announcements > 2) {
                failures.push(
                  `explore @ ${viewport.name}: announcement channel flooding ${checks.lensA11yBoundedAnnouncements}`,
                );
              }
              if (String(bounded.text).includes('The ball is at')) {
                failures.push(
                  `explore @ ${viewport.name}: announcement carried the full spatial paragraph`,
                );
              }
              if (
                checks.lensAnalystChrome === 'MISSING' ||
                checks.lensAccessibleChrome === 'MISSING'
              ) {
                failures.push(`explore @ ${viewport.name}: lens chrome missing`);
              }
              if (!checks.lensDescriptionSynced.startsWith('live')) {
                failures.push(
                  `explore @ ${viewport.name}: accessible description not synced (${checks.lensDescriptionSynced})`,
                );
              }

              // Session preference persistence + malformed revert.
              await page
                .getByRole('radio', { name: 'Analyst', exact: true })
                .click({ force: true });
              await page.waitForTimeout(300);
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
              await page.waitForFunction(
                () => (window as { __kyneloomLens?: unknown }).__kyneloomLens !== undefined,
                undefined,
                { timeout: 30_000 },
              );
              await page.waitForTimeout(600);
              const remembered = await page.evaluate(() => window.__kyneloomLens!.lens());
              checks.lensRemembered = remembered;
              if (remembered !== 'analyst') {
                failures.push(`explore @ ${viewport.name}: lens preference not remembered`);
              }
              await page.evaluate(() =>
                window.sessionStorage.setItem('kyneloom.lens', '{"role":"producer"}'),
              );
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
              await page.waitForFunction(
                () => (window as { __kyneloomLens?: unknown }).__kyneloomLens !== undefined,
                undefined,
                { timeout: 30_000 },
              );
              await page.waitForTimeout(600);
              const reverted = await page.evaluate(() => window.__kyneloomLens!.lens());
              checks.lensCorruptReverts = reverted;
              if (reverted !== 'fan') {
                failures.push(
                  `explore @ ${viewport.name}: malformed lens preference produced ${reverted}`,
                );
              }
              // A remembered lens must never override a chapter timestamp.
              await page.evaluate(() => window.sessionStorage.setItem('kyneloom.lens', 'analyst'));
              await page.goto(`${BASE}/moments`, { waitUntil: 'load', timeout: 60_000 });
              await page.locator('[data-catalog-id="ia-04-top-speed"]').scrollIntoViewIfNeeded();
              await page.locator('[data-catalog-id="ia-04-top-speed"]').click();
              await page.waitForURL('**/explore?moment=ia-04-top-speed', { timeout: 30_000 });
              await page.waitForFunction(
                () => (window as { __kyneloomLens?: unknown }).__kyneloomLens !== undefined,
                undefined,
                { timeout: 45_000 },
              );
              await page.waitForTimeout(800);
              const chapterState = await page.evaluate(() => ({
                playhead: window.__kyneloomLens!.playheadMs(),
                lens: window.__kyneloomLens!.lens(),
              }));
              checks.lensChapterIndependence = JSON.stringify(chapterState);
              if (chapterState.playhead !== 4_723_400 || chapterState.lens !== 'analyst') {
                failures.push(
                  `explore: remembered lens broke chapter selection ${checks.lensChapterIndependence}`,
                );
              }
              await page.evaluate(() => window.sessionStorage.removeItem('kyneloom.lens'));
              await page.goto(`${BASE}/explore`, { waitUntil: 'networkidle', timeout: 90_000 });
              await page.waitForFunction(
                () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
                undefined,
                { timeout: 45_000 },
              );
              // Software-GL resilience: the reload/navigation storm above can
              // exhaust SwiftShader contexts and silently drop the canvas to
              // the 2D fallback. Recover ONCE (fresh scene, analyst active)
              // so the deep block below verifies everything on a healthy
              // renderer — never by weakening an assertion.
              const sceneAliveAfterLens = await page.evaluate(
                () => typeof window.__kyneloomScene === 'object',
              );
              if (!sceneAliveAfterLens) {
                await page.goto(`${BASE}/explore`, { waitUntil: 'networkidle', timeout: 90_000 });
                await page.waitForFunction(
                  () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
                  undefined,
                  { timeout: 45_000 },
                );
                await page
                  .getByRole('radio', { name: 'Analyst', exact: true })
                  .click({ force: true });
                await page.waitForTimeout(700);
                checks.lensSceneRecovered = await page.evaluate(
                  () => typeof window.__kyneloomScene === 'object',
                );
                if (checks.lensSceneRecovered !== true) {
                  failures.push(
                    `explore @ ${viewport.name}: scene did not recover after lens churn`,
                  );
                }
              }

              // Lens evidence screenshots (fan / analyst / accessible).
              await page.screenshot({
                path: path.join(OUT_DIR, 'screenshots', `explore-lens-fan-${viewport.name}.png`),
              });
              await page
                .getByRole('radio', { name: 'Analyst', exact: true })
                .click({ force: true });
              await page.waitForTimeout(600);
              await page.screenshot({
                path: path.join(
                  OUT_DIR,
                  'screenshots',
                  `explore-lens-analyst-${viewport.name}.png`,
                ),
              });
              await page
                .getByRole('radio', { name: 'Accessible', exact: true })
                .click({ force: true });
              await page.waitForTimeout(900);
              await page.screenshot({
                path: path.join(
                  OUT_DIR,
                  'screenshots',
                  `explore-lens-accessible-${viewport.name}.png`,
                ),
              });
              // Leave ANALYST active: the deep camera/X-Ray checks below
              // operate through the analyst rail (the fan chrome has none).
              await page
                .getByRole('radio', { name: 'Analyst', exact: true })
                .click({ force: true });
              await page.waitForTimeout(400);
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
                budgetMs = 12_000,
              ) => {
                await page.getByRole('radio', { name: cam }).click({ force: true });
                const deadline = Date.now() + budgetMs;
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
                20_000,
              );
              checks.orbitExitConverged =
                orbitExit !== null && Math.hypot(orbitExit[1] - 92) < 1 ? 'yes' : 'NO';
              if (checks.orbitExitConverged !== 'yes') {
                failures.push(
                  `explore @ ${viewport.name}: camera failed to converge after orbit exit`,
                );
              }

              // Same bounded recovery immediately before the X-RAY block (it
              // has accumulated the most GPU churn: cameras, orbit, seeks).
              const sceneAlivePreXray = await page.evaluate(
                () => typeof window.__kyneloomScene === 'object',
              );
              if (!sceneAlivePreXray) {
                await page.goto(`${BASE}/explore`, { waitUntil: 'networkidle', timeout: 90_000 });
                await page.waitForFunction(
                  () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
                  undefined,
                  { timeout: 45_000 },
                );
                await page
                  .getByRole('radio', { name: 'Analyst', exact: true })
                  .click({ force: true });
                await page.waitForTimeout(700);
                if (
                  (await page.evaluate(() => typeof window.__kyneloomScene === 'object')) !== true
                ) {
                  failures.push(`explore @ ${viewport.name}: scene dead before X-Ray block`);
                }
              }

              // KYN-08 — Evidence X-Ray: the FULL click-to-claim-to-evidence
              // path in the real browser, plus invariance under camera
              // switches and scrubbing.
              const xray = page.getByRole('button', { name: 'X-Ray' });
              if ((await xray.count()) !== 1 || !(await xray.isEnabled())) {
                failures.push(`explore @ ${viewport.name}: X-Ray affordance missing/disabled`);
              } else {
                await xray.click();
                await page.waitForTimeout(700);
                const probeOn = await page.evaluate(() => ({
                  active: window.__kyneloomXray?.active() ?? false,
                  lines: window.__kyneloomXray?.visibleLineCount() ?? -1,
                  label: window.__kyneloomXray?.labelVisible() ?? false,
                }));
                checks.xrayOverlaysRendered =
                  probeOn.active && probeOn.lines >= 3 && probeOn.label
                    ? `yes (${String(probeOn.lines)} lines + label)`
                    : `NO ${JSON.stringify(probeOn)}`;
                if (!checks.xrayOverlaysRendered.startsWith('yes')) {
                  failures.push(
                    `explore @ ${viewport.name}: X-Ray overlays did not render ${JSON.stringify(probeOn)}`,
                  );
                }

                // Evidence invariance: camera switches and scrubbing never
                // change the measurement or canonical coordinates. Pause
                // defensively first — a stray transport state under heavy
                // load would otherwise drift the playhead mid-comparison.
                const playButton = page.locator('.stage__play');
                if ((await playButton.getAttribute('aria-pressed')) === 'true') {
                  await playButton.click();
                  await page.waitForTimeout(300);
                }
                const evidenceBefore = await page.evaluate(() =>
                  window.__kyneloomScene!.snapshot(),
                );
                for (const cam of ['Overhead', 'Follow', 'Goalkeeper', 'Broadcast']) {
                  await page.getByRole('radio', { name: cam }).click({ force: true });
                  await page.waitForTimeout(450);
                }
                await seek(4_717_400);
                await seek(4_728_300);
                await page.waitForTimeout(500);
                let evidenceAfter = await page.evaluate(() => window.__kyneloomScene!.snapshot());
                const worldPayload = (snap: unknown): string =>
                  JSON.stringify({
                    players: (snap as { players: unknown }).players,
                    ball: (snap as { ball: unknown }).ball,
                    missing: (snap as { missing: unknown }).missing,
                  });
                if (worldPayload(evidenceAfter) !== worldPayload(evidenceBefore)) {
                  // One bounded settle-retry: under load the first post-seek
                  // read can race the transport mirror.
                  await page.waitForTimeout(600);
                  evidenceAfter = await page.evaluate(() => window.__kyneloomScene!.snapshot());
                }
                checks.xrayWorldInvariant =
                  JSON.stringify({
                    players: evidenceBefore.players,
                    ball: evidenceBefore.ball,
                    missing: evidenceBefore.missing,
                  }) ===
                  JSON.stringify({
                    players: evidenceAfter.players,
                    ball: evidenceAfter.ball,
                    missing: evidenceAfter.missing,
                  })
                    ? 'identical'
                    : 'DIVERGED';
                if (checks.xrayWorldInvariant !== 'identical') {
                  failures.push(
                    `explore @ ${viewport.name}: world changed across X-Ray interactions`,
                  );
                }

                // Phase switch changes the drawn geometry (before-only).
                await page.getByRole('button', { name: 'Before', exact: true }).click();
                await page.waitForTimeout(500);
                const beforeLines = await page.evaluate(
                  () => window.__kyneloomXray?.visibleLineCount() ?? -1,
                );
                checks.xrayPhaseSwitch = beforeLines >= 2 ? `yes (${String(beforeLines)})` : 'NO';
                if (!checks.xrayPhaseSwitch.startsWith('yes')) {
                  failures.push(`explore @ ${viewport.name}: X-Ray phase switch drew nothing`);
                }

                // SCENE→INSPECTOR (review gate 3): click the REAL measured
                // geometry with actual pointer events. The probe projects
                // several candidate points along the visible line; the first
                // whose screen point is actually the canvas (floating UI
                // can legitimately cover part of the geometry on narrow
                // viewports) is clicked/tapped.
                await page.getByRole('radio', { name: 'Overhead' }).click({ force: true });
                await page.waitForTimeout(700);
                await page.getByRole('button', { name: 'Both', exact: true }).click({
                  force: true,
                });
                await page.waitForTimeout(450);
                const target = await page.evaluate(() => {
                  const canvas = document.querySelector('canvas');
                  const hits = window.__kyneloomXray?.hitTargetsScreen() ?? [];
                  if (canvas === null || hits.length === 0) return null;
                  const box = canvas.getBoundingClientRect();
                  for (let i = 0; i < hits.length; i += 1) {
                    const px = box.left + hits[i]!.x;
                    const py = box.top + hits[i]!.y;
                    if (document.elementFromPoint(px, py) === canvas) {
                      return { px, py, candidate: i, count: hits.length };
                    }
                  }
                  return { px: -1, py: -1, candidate: -1, count: hits.length };
                });
                if (target === null) {
                  failures.push(`explore @ ${viewport.name}: no scene click target (canvas/hits)`);
                } else if (target.candidate < 0) {
                  failures.push(
                    `explore @ ${viewport.name}: every geometry click target is occluded by floating UI`,
                  );
                } else {
                  const px = target.px;
                  const py = target.py;
                  let via = 'click';
                  if (viewport.name === '390x844') {
                    try {
                      await page.touchscreen.tap(px, py);
                      via = 'tap';
                    } catch {
                      await page.mouse.click(px, py); // context lacks hasTouch
                    }
                  } else {
                    await page.mouse.click(px, py);
                  }
                  await page.waitForTimeout(400);
                  const sceneClicked = (await page.getByTestId('evidence-sentence').count()) === 1;
                  checks.xraySceneClick = sceneClicked
                    ? `yes (${via} @ ${Math.round(px)},${Math.round(py)}, candidate ${String(target.candidate)}/${String(target.count - 1)})`
                    : 'NO';
                  if (!sceneClicked) {
                    failures.push(
                      `explore @ ${viewport.name}: clicking the separation geometry did not open the inspector`,
                    );
                  }
                  if (viewport.name === '1440x900' || viewport.name === '390x844') {
                    await evidenceShot(page, `explore-xray-click-${viewport.name}.png`, failures);
                  }
                  // Close via the inspector's own control — deterministic
                  // regardless of where the tap left keyboard focus (an
                  // Escape only works while focus is inside the stage).
                  await page.getByRole('button', { name: 'Close inspector' }).click();
                  await page.waitForTimeout(250);
                }

                // Inspector: computed values verbatim + provenance + frames.
                await page.getByRole('button', { name: 'Source evidence' }).click();
                await page.waitForTimeout(300);
                const sentence = await page.getByTestId('evidence-sentence').innerText();
                const deltaChip = await page.getByTestId('evidence-delta').innerText();
                const sentenceOk =
                  sentence.includes('6.306') &&
                  sentence.includes('20.344') &&
                  sentence.includes('14.038');
                checks.inspectorSentence = sentenceOk ? 'exact values' : sentence.slice(0, 80);
                if (!sentenceOk) {
                  failures.push(
                    `explore @ ${viewport.name}: inspector sentence not the computed values`,
                  );
                }
                checks.inspectorDelta = deltaChip.includes('14.038') ? 'exact' : deltaChip;
                if (checks.inspectorDelta !== 'exact') {
                  failures.push(
                    `explore @ ${viewport.name}: inspector delta chip wrong: ${deltaChip}`,
                  );
                }
                const interp = await page.getByTestId('evidence-interpretation').innerText();
                checks.inspectorInterpretation = interp.includes('INTERPRETATION')
                  ? 'labeled hypothesis'
                  : 'MISSING LABEL';
                if (checks.inspectorInterpretation !== 'labeled hypothesis') {
                  failures.push(`explore @ ${viewport.name}: interpretation label missing`);
                }
                await page.getByRole('button', { name: 'Show source frames' }).click();
                const framesText = await page.getByTestId('evidence-frames').innerText();
                checks.inspectorFrames =
                  framesText.includes('frame-47205') && framesText.includes('frame-47240')
                    ? 'exact frame ids'
                    : 'MISSING';
                if (checks.inspectorFrames !== 'exact frame ids') {
                  failures.push(`explore @ ${viewport.name}: source frame ids missing`);
                }
                // Frame navigation seeks; back-to-replay returns.
                await page.getByRole('button', { name: 'Go to before frame' }).click();
                await page.waitForTimeout(400);
                checks.inspectorSeek =
                  (await page.locator('.stage__slider').inputValue()) === '4720500' ? 'yes' : 'NO';
                if (checks.inspectorSeek !== 'yes') {
                  failures.push(`explore @ ${viewport.name}: evidence frame nav did not seek`);
                }
                await page.getByRole('button', { name: 'Back to replay' }).click();
                await page.waitForTimeout(400);
                // Keyboard: X off, X on, I opens, Escape closes.
                await page.locator('.stage__slider').focus();
                await page.keyboard.press('x');
                await page.waitForTimeout(250);
                await page.keyboard.press('x');
                await page.keyboard.press('i');
                await page.waitForTimeout(250);
                checks.xrayKeyboard =
                  (await page.getByTestId('evidence-sentence').count()) === 1 ? 'yes' : 'NO';
                if (checks.xrayKeyboard !== 'yes') {
                  failures.push(`explore @ ${viewport.name}: keyboard X/I path failed`);
                }
                await page.keyboard.press('Escape');
                await page.waitForTimeout(250);
                // Evidence screenshot per viewport (overhead for clarity).
                // X-Ray is still ON here (the keyboard 'x' above re-enabled
                // it; Escape only closed the inspector) — do NOT toggle again
                // before capturing, only switch to the tactical camera.
                await page.getByRole('radio', { name: 'Overhead' }).click({ force: true });
                await page.waitForTimeout(900);
                await evidenceShot(page, `explore-xray-${viewport.name}.png`, failures);
                await page.getByRole('button', { name: 'X-Ray' }).click({ force: true }); // off

                // BOUNDED RESOURCES (review gate 4): repeated toggling and
                // phase switching must not leak WebGL geometries/textures.
                if (viewport.name === '1440x900') {
                  const read = () =>
                    page.evaluate(() => ({
                      geometries: window.__kyneloomPerf?.geometries ?? -1,
                      textures: window.__kyneloomPerf?.textures ?? -1,
                    }));
                  await page.waitForTimeout(800);
                  const before = await read();
                  for (let round = 0; round < 4; round += 1) {
                    await page.getByRole('button', { name: 'X-Ray' }).click({ force: true });
                    await page.waitForTimeout(350);
                    for (const phase of ['After', 'Before', 'Both'] as const) {
                      await page.getByRole('button', { name: phase, exact: true }).click({
                        force: true,
                      });
                      await page.waitForTimeout(250);
                    }
                    await page.getByRole('button', { name: 'X-Ray' }).click({ force: true });
                    await page.waitForTimeout(350);
                  }
                  await page.waitForTimeout(1200);
                  const after = await read();
                  const dGeo = after.geometries - before.geometries;
                  const dTex = after.textures - before.textures;
                  checks.xrayResourcesBounded =
                    dGeo <= 2 && dTex <= 2
                      ? `ok (Δgeo +${String(dGeo)}, Δtex +${String(dTex)} after 4 on/off rounds × 3 phases)`
                      : `LEAK (Δgeo +${String(dGeo)}, Δtex +${String(dTex)})`;
                  if (!checks.xrayResourcesBounded.startsWith('ok')) {
                    failures.push(
                      `explore @ ${viewport.name}: X-Ray toggling leaked WebGL resources ${JSON.stringify({ before, after })}`,
                    );
                  }
                }
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
              await evidenceShot(page, `explore-directed-${viewport.name}.png`, failures);

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
          if (route.name === 'moments') {
            // KYN-10 — the gallery contract: a real catalog (≥12 distinct
            // chapters with distinct source timestamps), real scene-derived
            // previews, semantic links to the seam, no WebGL here, and honest
            // reduced-motion/touch behavior.
            await page.waitForFunction(
              () => (window as { __kyneloomMoments?: unknown }).__kyneloomMoments !== undefined,
              undefined,
              { timeout: 20_000 },
            );
            const probe = await page.evaluate(() => ({
              count: window.__kyneloomMoments!.count(),
              ids: window.__kyneloomMoments!.ids(),
              focusMs: window.__kyneloomMoments!.focusMs(),
              previews: window.__kyneloomMoments!.previewStatuses(),
              reduced: window.__kyneloomMoments!.reducedMotion(),
            }));
            checks.momentsCount = probe.count;
            checks.momentsDistinctIds = new Set(probe.ids).size;
            checks.momentsDistinctFocus = new Set(probe.focusMs).size;
            checks.momentsReducedMotion = probe.reduced;
            if (probe.count < 12 || new Set(probe.ids).size !== probe.count) {
              failures.push(
                `moments @ ${viewport.name}: catalog has ${probe.count} chapters / ${new Set(probe.ids).size} distinct ids`,
              );
            }
            if (new Set(probe.focusMs).size !== probe.count) {
              failures.push(`moments @ ${viewport.name}: chapter focus timestamps not distinct`);
            }
            // Every rendered card is a semantic link to the seam with its own
            // catalog id and focus; the featured CTA resolves too.
            const cards = page.locator('.mcard');
            checks.momentsCards = await cards.count();
            if (checks.momentsCards !== probe.count) {
              failures.push(
                `moments @ ${viewport.name}: ${checks.momentsCards} cards != ${probe.count} catalog chapters`,
              );
            }
            const hrefs = await page.evaluate(() =>
              Array.from(document.querySelectorAll<HTMLAnchorElement>('.mcard')).map((a) =>
                a.getAttribute('href'),
              ),
            );
            const hrefOk =
              hrefs.length === probe.count &&
              hrefs.every((href, i) => href === `/explore?moment=${probe.ids[i]}`);
            checks.momentsHrefs = hrefOk ? 'exact' : 'MISMATCH';
            if (!hrefOk) failures.push(`moments @ ${viewport.name}: card hrefs do not match ids`);
            checks.momentsFeaturedCta =
              (await page.locator('.featured__cta').getAttribute('href')) ===
              '/explore?moment=ia-00-invisible-assist';
            if (!checks.momentsFeaturedCta) {
              failures.push(`moments @ ${viewport.name}: featured CTA href wrong`);
            }
            // Real scene previews: every preview image loads and they are
            // distinct files (no repeated placeholder). Lazy images below
            // the fold are scrolled through first — that is the loading
            // contract a real visitor triggers.
            await page.evaluate(() => {
              for (const img of Array.from(document.querySelectorAll('img.mcard__image'))) {
                img.scrollIntoView({ block: 'nearest' });
              }
            });
            await page.waitForFunction(
              () =>
                Array.from(document.querySelectorAll<HTMLImageElement>('.mcard__image')).every(
                  (img) => img.complete,
                ),
              undefined,
              { timeout: 15_000 },
            );
            const images = await page.evaluate(() =>
              Array.from(document.querySelectorAll<HTMLImageElement>('.mcard__image')).map(
                (img) => ({
                  src: img.getAttribute('src'),
                  ok: img.complete && img.naturalWidth > 8,
                }),
              ),
            );
            checks.momentsPreviewsLoaded = `${images.filter((i) => i.ok).length}/${images.length}`;
            checks.momentsPreviewsDistinct = new Set(images.map((i) => i.src)).size;
            const renderedExpected = Object.values(probe.previews).filter(
              (s) => s === 'rendered',
            ).length;
            if (renderedExpected > 0 && images.filter((i) => i.ok).length < renderedExpected) {
              failures.push(
                `moments @ ${viewport.name}: only ${images.filter((i) => i.ok).length}/${renderedExpected} preview images loaded`,
              );
            }
            if (images.length > 1 && new Set(images.map((i) => i.src)).size !== images.length) {
              failures.push(`moments @ ${viewport.name}: repeated preview src among cards`);
            }
            // The gallery owns NO WebGL contexts.
            checks.momentsCanvases = await page.locator('canvas').count();
            if (checks.momentsCanvases !== 0) {
              failures.push(
                `moments @ ${viewport.name}: ${checks.momentsCanvases} canvases on the gallery (expected 0)`,
              );
            }
            // Spine: 12 real locator controls wired to chapters.
            checks.momentsSpineNodes = await page.locator('.moments__spine-node').count();
            if (checks.momentsSpineNodes !== probe.count) {
              failures.push(
                `moments @ ${viewport.name}: spine has ${checks.momentsSpineNodes} nodes != ${probe.count}`,
              );
            }
            // Featured motion preview present (video or poster fallback).
            checks.momentsFeaturedMedia =
              (await page.locator('.featured__video').count()) === 1 ? 'present' : 'MISSING';
            if (checks.momentsFeaturedMedia !== 'present') {
              failures.push(`moments @ ${viewport.name}: featured media missing`);
            }

            if (!reducedMotion) {
              // Hover reveal (fine pointers only): pointer onto a card lifts
              // it (data-tilt-active) and uncovers the hook; moving away
              // settles and leaves ZERO live tilt loops (no sustained rAF).
              if (viewport.name !== '390x844' && viewport.name !== '375x812') {
                const card = cards.first();
                await card.scrollIntoViewIfNeeded();
                const box = await card.boundingBox();
                if (box !== null) {
                  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3, {
                    steps: 6,
                  });
                  await page.waitForTimeout(500);
                  checks.momentsHoverTilt =
                    (await card.getAttribute('data-tilt-active')) === 'true' ? 'yes' : 'NO';
                  if (checks.momentsHoverTilt !== 'yes') {
                    failures.push(`moments @ ${viewport.name}: hover did not engage tilt`);
                  }
                  const hookOpacity = await page.evaluate(() => {
                    const hook = document.querySelector('.mcard__hook') as HTMLElement | null;
                    return hook === null ? -1 : Number(getComputedStyle(hook).opacity);
                  });
                  checks.momentsHoverReveal =
                    hookOpacity > 0.9 ? 'visible' : `opacity ${String(hookOpacity)}`;
                  if (hookOpacity <= 0.9) {
                    failures.push(
                      `moments @ ${viewport.name}: hook not revealed on hover (opacity ${String(hookOpacity)})`,
                    );
                  }
                  if (viewport.name === '1440x900') {
                    await evidenceShot(page, 'moments-hover-1440x900.png', failures);
                  }
                  // Sweep across every card, then leave the grid entirely.
                  for (let i = 0; i < probe.count; i += 1) {
                    const b = await cards.nth(i).boundingBox();
                    if (b !== null) {
                      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 2 });
                    }
                  }
                  await page.mouse.move(8, 8, { steps: 4 });
                  await page.waitForTimeout(1200);
                  const loops = await page.evaluate(() =>
                    window.__kyneloomMoments!.activeTiltLoops(),
                  );
                  checks.momentsTiltLoopsAfterLeave = loops;
                  if (loops !== 0) {
                    failures.push(
                      `moments @ ${viewport.name}: ${loops} tilt rAF loops still alive after pointer left`,
                    );
                  }
                }
              }
              // Motion preview pauses when scrolled out of view.
              const video = page.locator('.featured__video').first();
              if (
                (await video.count()) === 1 &&
                (await video.evaluate((el) => el.tagName)) === 'VIDEO'
              ) {
                await page.locator('#chapters').scrollIntoViewIfNeeded();
                await page.waitForTimeout(1200);
                checks.momentsMotionOffscreenPaused = await video.evaluate(
                  (el) => (el as HTMLVideoElement).paused,
                );
                if (checks.momentsMotionOffscreenPaused !== true) {
                  failures.push(
                    `moments @ ${viewport.name}: featured motion kept playing offscreen`,
                  );
                }
              }
            } else {
              // Reduced motion: discovery fully intact, zero spatial card
              // animation (sweep the grid; no tilt loops may ever start).
              const card = cards.first();
              await card.scrollIntoViewIfNeeded();
              const box = await card.boundingBox();
              if (box !== null) {
                await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3, {
                  steps: 4,
                });
                await page.waitForTimeout(600);
                checks.momentsReducedTiltStatic = await page.evaluate(() =>
                  window.__kyneloomMoments!.activeTiltLoops(),
                );
                if (checks.momentsReducedTiltStatic !== 0) {
                  failures.push(
                    `moments reduced-motion @ ${viewport.name}: tilt loops started (${checks.momentsReducedTiltStatic})`,
                  );
                }
              }
              checks.momentsReducedCardsStillLinks = (await cards.count()) === probe.count;
            }
            // Mobile (no hover): a real touch tap on a card activates the
            // seam — the same navigation hover would drive on desktop.
            if (viewport.name === '390x844') {
              const first = cards.first();
              await first.scrollIntoViewIfNeeded();
              const box = await first.boundingBox();
              if (box !== null) {
                await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4);
                await page.waitForURL('**/explore?moment=**', { timeout: 20_000 }).then(
                  () => undefined,
                  () => undefined,
                );
                checks.momentsTouchNavigation = page.url().includes('/explore?moment=');
                if (!checks.momentsTouchNavigation) {
                  failures.push(`moments @ 390x844: touch tap did not open the replay`);
                }
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
    await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 90_000 });
    await page.getByTestId('enter-the-moment').click();
    await page.waitForURL('**/explore**', { timeout: 30_000 });
    const navWorks = page.url().includes('/explore');
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

    // KYN-10 — the gallery→replay selection seam, exercised end to end:
    // two genuinely different cards open DIFFERENT correct playheads with
    // the canonical player/ball positions at those times; direct URLs work;
    // unknown/malformed ids fail safely; the default route is unchanged;
    // repeated navigation leaks nothing; keyboard activates cards.
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      const checks: Record<string, boolean | number | string> = {};

      const openCardAndAssert = async (
        catalogId: string,
        expectedFocusMs: number,
        ballTruth: { xM: number; yM: number; zM: number },
      ): Promise<void> => {
        await page.goto(`${BASE}/moments`, { waitUntil: 'load', timeout: 60_000 });
        await page.locator(`[data-catalog-id="${catalogId}"]`).scrollIntoViewIfNeeded();
        await page.locator(`[data-catalog-id="${catalogId}"]`).click();
        await page.waitForURL(`**/explore?moment=${catalogId}`, { timeout: 30_000 });
        await page.waitForFunction(
          () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
          undefined,
          { timeout: 45_000 },
        );
        await page.waitForTimeout(600);
        const snap = await page.evaluate(() => window.__kyneloomScene!.snapshot());
        const ballOk =
          snap.ball !== null &&
          Math.abs(snap.ball.xM - ballTruth.xM) < 0.001 &&
          Math.abs(snap.ball.yM - ballTruth.yM) < 0.001 &&
          Math.abs(snap.ball.zM - ballTruth.zM) < 0.001 &&
          snap.ball.exact === true;
        if (snap.playheadMs !== expectedFocusMs || snap.players.length !== 22 || !ballOk) {
          failures.push(
            `moments seam ${catalogId}: playhead ${String(snap.playheadMs)} (want ${String(expectedFocusMs)}), players ${String(snap.players.length)}, ball ${JSON.stringify(snap.ball)}`,
          );
        }
      };
      // Chapter 1 (window open) and chapter 10 (the goal): two genuinely
      // different cards → different correct source times with golden ball
      // truth at each (fixture seed 24017 exact frames).
      await openCardAndAssert('ia-01-possession-settles', 4_717_000, {
        xM: 5.156,
        yM: 2.498,
        zM: 0.11,
      });
      await openCardAndAssert('ia-10-the-equalizer', 4_728_300, {
        xM: 52.4,
        yM: -2,
        zM: 0.11,
      });
      checks.seamTwoCardsDistinct = 'ok';

      // The chapter chip names the selection on the stage.
      checks.seamChapterChip = await page.locator('[data-chapter-chip]').first().innerText();

      // Direct navigation to a valid catalog selection.
      await page.goto(`${BASE}/explore?moment=ia-04-top-speed`, {
        waitUntil: 'load',
        timeout: 60_000,
      });
      await page.waitForFunction(
        () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
        undefined,
        { timeout: 45_000 },
      );
      const directPlayhead = await page.evaluate(() => window.__kyneloomScene!.playheadMs());
      checks.seamDirectNav =
        directPlayhead === 4_723_400 ? 'ok' : `WRONG ${String(directPlayhead)}`;
      if (directPlayhead !== 4_723_400) {
        failures.push(`seam direct nav: playhead ${String(directPlayhead)} != 4723400`);
      }

      // Honest evidence context (KYN-10): the note must NOT appear while
      // INSIDE the measured interval (ia-04 at 78:43.4 is inside), then at
      // the equalizer (78:48.3, outside) X-Ray shows the contextual note
      // and jumping grounds the playhead on the interval. KYN-11: the X-Ray
      // affordance lives in the Analyst rail — switch there first.
      await page.getByRole('radio', { name: 'Analyst', exact: true }).click({ force: true });
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: 'X-Ray' }).click({ force: true });
      await page.waitForTimeout(700);
      const noteInsideInterval = await page.locator('[data-evidence-context]').first().isVisible();
      checks.seamEvidenceNoteSuppressedInside = noteInsideInterval
        ? 'SHOWN (wrong)'
        : 'hidden (correct)';
      if (noteInsideInterval) {
        failures.push('seam: evidence note appeared while INSIDE the measured interval');
      }
      await page.goto(`${BASE}/explore?moment=ia-10-the-equalizer`, {
        waitUntil: 'load',
        timeout: 60_000,
      });
      await page.waitForFunction(
        () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
        undefined,
        { timeout: 45_000 },
      );
      await page.getByRole('button', { name: 'X-Ray' }).click({ force: true });
      await page.waitForTimeout(700);
      checks.seamEvidenceNote = (await page.locator('[data-evidence-context]').first().isVisible())
        ? 'shown'
        : 'MISSING';
      if (checks.seamEvidenceNote !== 'shown') {
        failures.push('seam: outside-interval evidence note did not appear');
      }
      // Force-click, same convention as the X-Ray/Analyst controls above:
      // Playwright's scroll-into-view can drag this top-band overlay under
      // the fixed site header on the software renderer; the resting layout
      // keeps the button fully clear (asserted by the live-panel probe).
      await page.getByRole('button', { name: 'Go to measured interval' }).click({ force: true });
      await page.waitForTimeout(600);
      const afterSeek = await page.evaluate(() => ({
        playhead: window.__kyneloomScene!.playheadMs(),
        noteHidden: (document.querySelector('[data-evidence-context]') as HTMLElement | null)
          ?.hidden,
      }));
      checks.seamEvidenceJump = JSON.stringify(afterSeek);
      if (afterSeek.playhead !== 4_720_500 || afterSeek.noteHidden !== true) {
        failures.push(`seam evidence jump: ${checks.seamEvidenceJump}`);
      }
      await page.getByRole('button', { name: 'X-Ray' }).click({ force: true }); // off

      // Unknown and malformed catalog ids fail safely: honest notice, the
      // default checkpoint stays authoritative, page stays healthy.
      for (const bad of ['does-not-exist', '%3Cscript%3Ealert(1)%3C%2Fscript%3E']) {
        await page.goto(`${BASE}/explore?moment=${bad}`, { waitUntil: 'load', timeout: 60_000 });
        await page.waitForFunction(
          () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
          undefined,
          { timeout: 45_000 },
        );
        const state = await page.evaluate(() => ({
          notice: document.querySelector('[data-unknown-moment]') !== null,
          playhead: window.__kyneloomScene!.playheadMs(),
        }));
        checks[`seamRejects(${bad.slice(0, 14)})`] = JSON.stringify(state);
        if (!state.notice || state.playhead !== 4_722_100) {
          failures.push(`seam rejection ${bad}: ${JSON.stringify(state)}`);
        }
      }

      // The default route is unchanged by all of this.
      await page.goto(`${BASE}/explore`, { waitUntil: 'load' });
      await page.waitForFunction(
        () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
        undefined,
        { timeout: 45_000 },
      );
      const defaultPlayhead = await page.evaluate(() => window.__kyneloomScene!.playheadMs());
      checks.seamDefaultExplore =
        defaultPlayhead === 4_722_100 ? 'checkpoint' : String(defaultPlayhead);
      if (defaultPlayhead !== 4_722_100) {
        failures.push(`default /explore playhead ${String(defaultPlayhead)} != 4722100`);
      }

      // Keyboard activation: Tab reaches the first card; Enter opens it.
      await page.goto(`${BASE}/moments`, { waitUntil: 'load', timeout: 60_000 });
      await page.locator('.moments__title').focus(); // deterministic Tab start
      let cardFocused = false;
      for (let i = 0; i < 30 && !cardFocused; i += 1) {
        await page.keyboard.press('Tab');
        cardFocused = await page.evaluate(
          () => document.activeElement?.classList.contains('mcard') ?? false,
        );
      }
      checks.seamKeyboardTab = cardFocused;
      if (!cardFocused) {
        failures.push('seam keyboard: Tab never reached a moment card');
      } else {
        const focusVisible = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el !== null && getComputedStyle(el).outlineStyle !== 'none';
        });
        checks.seamKeyboardFocusVisible = focusVisible;
        if (!focusVisible) failures.push('seam keyboard: focus ring not visible on card');
        await page.keyboard.press('Enter');
        await page.waitForURL('**/explore?moment=**', { timeout: 30_000 });
        checks.seamKeyboardEnter = page.url().includes('/explore?moment=');
        if (!checks.seamKeyboardEnter) {
          failures.push('seam keyboard: Enter did not open the selected moment');
        }
      }

      // Repeated navigation leaks neither canvases nor previews nor loops.
      for (let round = 0; round < 3; round += 1) {
        await page.goto(`${BASE}/moments`, { waitUntil: 'load', timeout: 60_000 });
        await page.locator('.mcard').first().click();
        await page.waitForURL('**/explore?moment=**', { timeout: 30_000 });
      }
      await page.goto(`${BASE}/moments`, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForFunction(
        () => (window as { __kyneloomMoments?: unknown }).__kyneloomMoments !== undefined,
        undefined,
        { timeout: 20_000 },
      );
      // Freshly mounted cards each wake ONE settle frame (the visibility
      // observer confirms them, springs are already at rest, the loop
      // retires next tick). The leak property is that everything SETTLES to
      // zero AND STAYS there. A naive mount-instant read races the
      // observer's initial callbacks (zero loops before the transient wake
      // even starts), so: let the initial observer pass land first, then
      // require a STABLE zero — three consecutive reads across half a
      // second.
      await page.waitForTimeout(900);
      const settledToZero = await page
        .waitForFunction(
          () =>
            (
              window as { __kyneloomMoments?: { activeTiltLoops(): number } }
            ).__kyneloomMoments?.activeTiltLoops() === 0,
          undefined,
          { timeout: 5000, polling: 120 },
        )
        .then(() => true)
        .catch(() => false);
      if (settledToZero) {
        for (let i = 0; i < 3; i += 1) {
          await page.waitForTimeout(170);
          if (
            (await page.evaluate(
              () =>
                (
                  window as { __kyneloomMoments?: { activeTiltLoops(): number } }
                ).__kyneloomMoments?.activeTiltLoops() ?? -1,
            )) !== 0
          ) {
            checks.seamRepeatNav = `unstable zero (loop re-woke after settling)`;
            failures.push(`seam repeated navigation leaked: tilt loops re-woke after settling`);
            break;
          }
        }
      }
      const leakState = await page.evaluate(() => ({
        canvases: document.querySelectorAll('canvas').length,
        cards: document.querySelectorAll('.mcard').length,
        images: document.querySelectorAll('.mcard__image').length,
        tiltLoops: window.__kyneloomMoments!.activeTiltLoops(),
      }));
      checks.seamRepeatNav = JSON.stringify({ ...leakState, settledToZero });
      if (
        !settledToZero ||
        leakState.canvases !== 0 ||
        leakState.cards !== 12 ||
        leakState.images !== 12 ||
        leakState.tiltLoops !== 0
      ) {
        failures.push(`seam repeated navigation leaked: ${checks.seamRepeatNav}`);
      }
      if (consoleErrors.length > 0) {
        failures.push(`moments seam console errors: ${consoleErrors.length}`);
      }
      results.push({
        route: 'moments-seam',
        viewport: '1440x900',
        reducedMotion: false,
        screenshot: 'screenshots/moments-1440x900.png',
        horizontalOverflowPx: 0,
        consoleErrors,
        checks,
      });
      await context.close();
    }

    // KYN-12 — the agent metric API: real HTTP executions and adversarial
    // rejections against the production server (docs/07 get_metric).
    {
      const post = async (
        body: unknown,
      ): Promise<{ status: number; json: Record<string, unknown> }> => {
        const res = await fetch(`${BASE}/api/agent/metric`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      const apiChecks: Record<string, boolean | number | string> = {};
      const apiFailures: string[] = [];

      // Valid separation query — the canonical verified numbers.
      const good = await post({
        matchId: 'synthetic-derby-01',
        query: {
          kind: 'separation-delta',
          defenderId: 'away-03',
          strikerId: 'home-09',
          fromMs: 4720500,
          toMs: 4724000,
        },
      });
      const goodResult = good.json['result'] as
        | {
            status?: string;
            value?: { deltaM?: number };
            provenance?: { algorithmVersion?: string };
          }
        | undefined;
      apiChecks.separationStatus = good.status;
      apiChecks.separationDelta = String(goodResult?.value?.deltaM ?? 'none');
      if (
        good.status !== 200 ||
        goodResult?.status !== 'verified' ||
        goodResult.value?.deltaM !== 14.038 ||
        goodResult.provenance?.algorithmVersion !== 'kyneloom-separation-v1'
      ) {
        apiFailures.push(
          `valid separation query returned ${JSON.stringify(good.json).slice(0, 200)}`,
        );
      }

      // Valid movement query on the run.
      const movement = await post({
        matchId: 'synthetic-derby-01',
        query: { kind: 'off-ball-movement', entityId: 'home-11', fromMs: 4720500, toMs: 4724000 },
      });
      const movementResult = movement.json['result'] as
        { status?: string; value?: { displacementM?: number } } | undefined;
      apiChecks.movementStatus = movement.status;
      apiChecks.movementDisplacement = String(movementResult?.value?.displacementM ?? 'none');
      if (movement.status !== 200 || movementResult?.status !== 'verified') {
        apiFailures.push(`movement query failed: ${JSON.stringify(movement.json).slice(0, 160)}`);
      }

      // Adversarial rejections.
      const hostile: {
        body: unknown;
        expectedStatus: number;
        expectedCode: string;
        label: string;
      }[] = [
        {
          label: 'unknown match',
          expectedStatus: 404,
          expectedCode: 'match-not-authorized',
          body: {
            matchId: 'premier-league-2024',
            query: { kind: 'nearest-opponent', entityId: 'home-11', atMs: 4722100 },
          },
        },
        {
          label: 'arbitrary SQL kind',
          expectedStatus: 400,
          expectedCode: 'unsupported-metric',
          body: {
            matchId: 'synthetic-derby-01',
            query: { kind: 'raw-sql', sql: 'DROP TABLE matches' },
          },
        },
        {
          label: 'freeform tool name',
          expectedStatus: 400,
          expectedCode: 'unsupported-metric',
          body: {
            matchId: 'synthetic-derby-01',
            query: { kind: 'execute_tool', tool: 'publish_release' },
          },
        },
        {
          label: 'path traversal entity',
          expectedStatus: 400,
          expectedCode: 'invalid-entity',
          body: {
            matchId: 'synthetic-derby-01',
            query: { kind: 'nearest-opponent', entityId: '../../etc/passwd', atMs: 4722100 },
          },
        },
        {
          label: 'stale revision',
          expectedStatus: 409,
          expectedCode: 'stale-revision',
          body: {
            matchId: 'synthetic-derby-01',
            reducerRevision: 1,
            query: {
              kind: 'separation-delta',
              defenderId: 'away-03',
              strikerId: 'home-09',
              fromMs: 4720500,
              toMs: 4724000,
            },
          },
        },
        {
          label: 'oversized window',
          expectedStatus: 400,
          expectedCode: 'window-too-large',
          body: {
            matchId: 'synthetic-derby-01',
            query: {
              kind: 'separation-delta',
              defenderId: 'away-03',
              strikerId: 'home-09',
              fromMs: 0,
              toMs: 10_000_000,
            },
          },
        },
        {
          label: 'unknown entity',
          expectedStatus: 400,
          expectedCode: 'unknown-entity',
          body: {
            matchId: 'synthetic-derby-01',
            query: { kind: 'nearest-opponent', entityId: 'home-99', atMs: 4722100 },
          },
        },
        {
          label: 'malformed body',
          expectedStatus: 400,
          expectedCode: 'malformed-body',
          body: 'not-an-object',
        },
      ];
      for (const attempt of hostile) {
        const rejected = await post(attempt.body);
        apiChecks[`reject:${attempt.label}`] =
          `${String(rejected.status)}/${String(rejected.json['code'])}`;
        if (
          rejected.status !== attempt.expectedStatus ||
          rejected.json['code'] !== attempt.expectedCode
        ) {
          apiFailures.push(
            `${attempt.label}: expected ${String(attempt.expectedStatus)}/${attempt.expectedCode}, got ${String(rejected.status)}/${String(rejected.json['code'])}`,
          );
        }
      }

      // GET is a documented 405.
      const getRes = await fetch(`${BASE}/api/agent/metric`);
      apiChecks.getMethod = getRes.status;
      if (getRes.status !== 405) apiFailures.push(`GET expected 405, got ${String(getRes.status)}`);

      // REVIEW GATE 3 — source freshness: a TRACKING-ONLY correction on disk
      // (event count, hence reducerRevision, unchanged) between two
      // consecutive requests must be reflected in the served values. The
      // fixture file is restored byte-exact in finally; nothing is committed.
      {
        const fixturePath = path.resolve(
          'tests/fixtures/generated/synthetic-derby-01/tracking.jsonl',
        );
        const original = readFileSync(fixturePath, 'utf-8');
        const sepQuery = async (): Promise<{ status: number; json: Record<string, unknown> }> => {
          const res = await fetch(`${BASE}/api/agent/metric`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tool: 'get_metric',
              matchId: 'synthetic-derby-01',
              query: {
                kind: 'separation-delta',
                defenderId: 'away-03',
                strikerId: 'home-09',
                fromMs: 4_720_500,
                toMs: 4_724_000,
              },
            }),
          });
          return { status: res.status, json: (await res.json()) as Record<string, unknown> };
        };
        try {
          const before = await sepQuery();
          const beforeBody = before.json as {
            ok?: boolean;
            result?: {
              provenance?: { inputFingerprint?: string; reducerRevision?: number };
              value?: { deltaM?: number; separationAfterM?: number };
            };
          };
          const beforeFp = beforeBody.result?.provenance?.inputFingerprint ?? null;
          const beforeDelta = beforeBody.result?.value?.deltaM ?? null;
          const beforeRevision = beforeBody.result?.provenance?.reducerRevision ?? null;

          // TRACKING-ONLY correction: move away-03 at the toMs endpoint by
          // +2 m. No event envelope is touched — reducerRevision cannot move.
          const lines = original.split('\n').filter((l) => l.trim() !== '');
          const corrected = lines
            .map((line) => {
              const parsed = JSON.parse(line) as {
                entityId?: string;
                sampleTimeMs?: number;
                xM?: number;
              };
              if (parsed.entityId === 'away-03' && parsed.sampleTimeMs === 4_724_000) {
                parsed.xM = (parsed.xM ?? 0) + 2;
                return JSON.stringify(parsed);
              }
              return line;
            })
            .join('\n');
          writeFileSync(fixturePath, corrected);

          const after = await sepQuery();
          const afterBody = after.json as typeof beforeBody;
          const afterFp = afterBody.result?.provenance?.inputFingerprint ?? null;
          const afterDelta = afterBody.result?.value?.deltaM ?? null;
          const afterRevision = afterBody.result?.provenance?.reducerRevision ?? null;

          apiChecks.freshness = JSON.stringify({
            beforeFp,
            afterFp,
            beforeDelta,
            afterDelta,
            sameRevision: beforeRevision === afterRevision,
          });
          const freshnessOk =
            beforeFp !== null &&
            afterFp !== null &&
            beforeFp !== afterFp &&
            beforeDelta !== afterDelta &&
            beforeRevision === afterRevision; // proves a revision-keyed cache could NOT have caught this
          if (!freshnessOk) {
            apiFailures.push(
              `stale context served after tracking-only correction: ${apiChecks.freshness}`,
            );
          }
        } finally {
          writeFileSync(fixturePath, original);
        }
      }

      results.push({
        route: 'agent-metric-api',
        viewport: '1440x900',
        reducedMotion: false,
        screenshot: 'screenshots/moments-1440x900.png',
        horizontalOverflowPx: 0,
        consoleErrors: [],
        checks: apiChecks,
      });
      for (const failure of apiFailures) failures.push(`agent metric API: ${failure}`);
    }

    // KYN-13 — live synthetic stream: recorded→live mode transition, honest
    // status, real streamed state, reconnect/resync, desktop + mobile.
    {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      await page.goto(BASE + '/explore', { waitUntil: 'networkidle', timeout: 90_000 });
      await page.waitForFunction(
        () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
        undefined,
        { timeout: 60_000 },
      );

      // The live status chip exists and reports the recorded mode honestly.
      const recordedStatus = await page
        .locator('[data-testid="live-status"]')
        .getAttribute('data-live-status');
      const liveChecks: Record<string, boolean | number | string> = {
        recordedStatus: recordedStatus ?? '(missing)',
      };
      if (recordedStatus !== 'recorded') {
        failures.push(`live @ 1440x900: initial chip ${String(recordedStatus)} != recorded`);
      }

      // Activate live mode; under software rendering SSE dispatch is slow,
      // so poll patiently for the genuinely connected state.
      await page.getByTestId('live-mode-toggle').click();
      let connectedState: string | null = null;
      try {
        await page.waitForFunction(
          () => {
            const chip = document.querySelector('[data-testid="live-status"]');
            const status = chip?.getAttribute('data-live-status') ?? '';
            return status === 'connected' || status === 'degraded';
          },
          undefined,
          { timeout: 90_000, polling: 500 },
        );
      } catch {
        /* falls through to the read below */
      }
      connectedState = await page
        .locator('[data-testid="live-status"]')
        .getAttribute('data-live-status');
      liveChecks.connectedStatus = connectedState ?? '(none)';
      if (connectedState !== 'connected' && connectedState !== 'degraded') {
        failures.push(`live @ 1440x900: never reached connected (got ${String(connectedState)})`);
      }

      // Streamed state genuinely applied: 22 players from the live timeline.
      // Patient poll — the scene's render loop lags the React commit under
      // the software renderer, so 'connected' can precede the first streamed
      // frame by many seconds.
      try {
        await page.waitForFunction(
          () => (window.__kyneloomScene?.snapshot?.().players.length ?? -1) === 22,
          undefined,
          { timeout: 90_000, polling: 500 },
        );
      } catch {
        /* falls through to the recorded read below */
      }
      const applied = await page.evaluate(() => {
        const chip = document.querySelector('[data-testid="live-status"]');
        return {
          meta: chip?.querySelector('.livechip__meta')?.textContent ?? null,
          players: window.__kyneloomScene?.snapshot?.().players.length ?? -1,
          playhead: window.__kyneloomScene?.playheadMs?.() ?? null,
        };
      });
      liveChecks.applied = JSON.stringify(applied);
      if (applied.players !== 22) {
        failures.push(
          `live @ 1440x900: streamed scene has ${String(applied.players)} players (expected 22)`,
        );
      }
      await evidenceShot(page, 'explore-live-connected-1440x900.png', failures);

      // Interruption/resync — the GENUINE path: the operator control stops
      // the real producer; the SSE loop tells the truth (a disconnected
      // status frame) and closes; reconnecting viewers resynchronize from
      // the canonical snapshot. (context.setOffline is NOT used as the
      // interruption: on this host it does not cut an established SSE
      // socket — probed: readyState stays OPEN and frames keep flowing —
      // so a chip that stays 'connected' would be TRUTHFUL, and asserting
      // against it would test a false premise. The DOM flip needs a React
      // commit on a possibly-starved renderer, hence the long window; the
      // never-fake-LIVE rule stays strict.)
      await fetch(`${BASE}/api/live/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      let offlineStatus: string | null = null;
      try {
        await page.waitForFunction(
          () => {
            const status =
              document
                .querySelector('[data-testid="live-status"]')
                ?.getAttribute('data-live-status') ?? '';
            return (
              status === 'disconnected' ||
              status === 'reconnecting' ||
              status === 'connecting' ||
              status === 'resynchronizing'
            );
          },
          undefined,
          { timeout: 120_000, polling: 500 },
        );
      } catch {
        /* the read below records the truth either way */
      }
      offlineStatus = await page
        .locator('[data-testid="live-status"]')
        .getAttribute('data-live-status');
      liveChecks.offlineStatus = offlineStatus ?? '(none)';
      // The never-fake-LIVE rule: a stopped stream must NOT claim live.
      if (offlineStatus === 'connected' || offlineStatus === 'degraded') {
        failures.push('live @ 1440x900: chip stayed live while the stream was stopped (fake LIVE)');
      }
      await evidenceShot(page, 'explore-live-offline-1440x900.png', failures);

      await fetch(`${BASE}/api/live/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      try {
        await page.waitForFunction(
          () => {
            const status =
              document
                .querySelector('[data-testid="live-status"]')
                ?.getAttribute('data-live-status') ?? '';
            return status === 'connected' || status === 'degraded';
          },
          undefined,
          { timeout: 120_000, polling: 500 },
        );
      } catch {
        /* recovery may take longer under software rendering */
      }
      const recoveredStatus = await page
        .locator('[data-testid="live-status"]')
        .getAttribute('data-live-status');
      liveChecks.recoveredStatus = recoveredStatus ?? '(none)';
      if (recoveredStatus !== 'connected' && recoveredStatus !== 'degraded') {
        failures.push(
          `live @ 1440x900: stream did not recover after restart (${String(recoveredStatus)})`,
        );
      }
      // Resync proof: the recovered timeline again carries exactly the 22
      // streamed players — the snapshot round-trip, not a stale scene.
      try {
        await page.waitForFunction(
          () => (window.__kyneloomScene?.snapshot?.().players.length ?? -1) === 22,
          undefined,
          { timeout: 90_000, polling: 500 },
        );
      } catch {
        /* recorded below */
      }
      const recoveredPlayers = await page.evaluate(
        () => window.__kyneloomScene?.snapshot?.().players.length ?? -1,
      );
      liveChecks.recoveredPlayers = recoveredPlayers;
      if (recoveredPlayers !== 22) {
        failures.push(
          `live @ 1440x900: recovered scene has ${String(recoveredPlayers)} players (expected 22)`,
        );
      }
      await evidenceShot(page, 'explore-live-recovered-1440x900.png', failures);

      // Service telemetry: rate, quarantine, archive counts recorded.
      const serviceStatus = await (await fetch(`${BASE}/api/live/status`)).json();
      liveChecks.serviceStatus = JSON.stringify({
        running: serviceStatus.status?.running,
        quarantined: serviceStatus.status?.quarantined,
        archived: serviceStatus.status?.archivedEnvelopes,
        dropped: serviceStatus.status?.droppedSubscribers,
      });
      if ((serviceStatus.status?.quarantined ?? 0) > 0) {
        failures.push(
          `live: ${String(serviceStatus.status.quarantined)} quarantined envelopes in the clean run`,
        );
      }

      results.push({
        route: 'live-stream',
        viewport: '1440x900',
        reducedMotion: false,
        screenshot: 'screenshots/explore-live-connected-1440x900.png',
        horizontalOverflowPx: 0,
        consoleErrors,
        checks: liveChecks,
      });

      // Mobile: the live panel is reachable and the chip honest.
      const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      const mobilePage = await mobileContext.newPage();
      await mobilePage.goto(BASE + '/explore', { waitUntil: 'networkidle', timeout: 90_000 });
      await mobilePage.waitForFunction(
        () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
        undefined,
        { timeout: 60_000 },
      );
      const mobileRecorded = await mobilePage
        .locator('[data-testid="live-status"]')
        .getAttribute('data-live-status');
      const mobileChecks: Record<string, boolean | number | string> = {
        recordedStatus: mobileRecorded ?? '(missing)',
      };
      if (mobileRecorded !== 'recorded') {
        failures.push(`live @ 390x844: initial chip ${String(mobileRecorded)} != recorded`);
      }
      const mobileOverflow = await mobilePage.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      mobileChecks.overflowPx = mobileOverflow;
      if (mobileOverflow > 0) {
        failures.push(`live @ 390x844: horizontal overflow ${String(mobileOverflow)}px`);
      }
      await mobilePage.screenshot({
        path: path.join(OUT_DIR, 'screenshots', 'explore-live-panel-390x844.png'),
      });
      results.push({
        route: 'live-stream',
        viewport: '390x844',
        reducedMotion: false,
        screenshot: 'screenshots/explore-live-panel-390x844.png',
        horizontalOverflowPx: mobileOverflow,
        consoleErrors: [],
        checks: mobileChecks,
      });
      await mobileContext.close();
      await context.close();
    }

    // KYN-09 acceptance 9 — WebGL-unavailable landing: a truthful fallback
    // (poster + direct CTA link), verified in a browser with WebGL off.
    {
      const noGlBrowser = await chromium.launch({ headless: true, args: ['--disable-webgl'] });
      try {
        const noGlContext = await noGlBrowser.newContext({ viewport: { width: 375, height: 812 } });
        const noGlPage = await noGlContext.newPage();
        await noGlPage.goto(BASE + '/', { waitUntil: 'networkidle' });
        await noGlPage.waitForFunction(
          () =>
            document.querySelector('.landing__stage')?.getAttribute('data-phase') === 'fallback',
          undefined,
          { timeout: 15_000 },
        );
        const ctaHref = await noGlPage.getByTestId('enter-the-moment').getAttribute('href');
        const poster = await noGlPage.locator('.landing__poster').count();
        await noGlPage.screenshot({
          path: path.join(OUT_DIR, 'screenshots', 'landing-fallback-375x812.png'),
        });
        const fallbackOk = ctaHref === '/explore' && poster === 1;
        if (!fallbackOk) {
          failures.push(
            `landing fallback (WebGL off): CTA href ${String(ctaHref)}, poster ${String(poster)}`,
          );
        }
        results.push({
          route: 'landing-fallback',
          viewport: '375x812',
          reducedMotion: false,
          screenshot: 'screenshots/landing-fallback-375x812.png',
          horizontalOverflowPx: 0,
          consoleErrors: [],
          checks: { ctaHref: ctaHref ?? '(none)', poster: poster },
        });
        await noGlContext.close();
      } finally {
        await noGlBrowser.close();
      }
    }

    // KYN-10 review round 2 — degraded-fixture route safety: a fixture that
    // LOADS but fails catalog validation (here: the ia-12 chapter's focus
    // frame removed from a scratch copy; the default checkpoint keeps full
    // 23-entity coverage) must render honest states on BOTH routes — never
    // a server error — and the default /explore replay must survive intact.
    {
      const degradedPort = 3185;
      const degradedBase = `http://127.0.0.1:${degradedPort}`;
      const scratchRoot = path.join(OUT_DIR, '.degraded-fixture');
      const degradedDir = path.join(scratchRoot, 'generated', 'synthetic-derby-01');
      rmSync(scratchRoot, { recursive: true, force: true });
      mkdirSync(degradedDir, { recursive: true });
      const sourceDir = path.resolve('tests', 'fixtures', 'generated', 'synthetic-derby-01');
      copyFileSync(path.join(sourceDir, 'events.json'), path.join(degradedDir, 'events.json'));
      copyFileSync(path.join(sourceDir, 'metadata.json'), path.join(degradedDir, 'metadata.json'));
      const keptLines = readFileSync(path.join(sourceDir, 'tracking.jsonl'), 'utf-8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          if (trimmed === '') return false;
          try {
            return (JSON.parse(trimmed) as { sampleTimeMs: number }).sampleTimeMs !== 4_731_000;
          } catch {
            return false;
          }
        });
      writeFileSync(path.join(degradedDir, 'tracking.jsonl'), `${keptLines.join('\n')}\n`);

      const degradedServer = spawn(
        'pnpm',
        ['--filter', '@kyneloom/web', 'start', '--port', String(degradedPort)],
        { shell: true, stdio: 'pipe', env: { ...process.env, KYNELOOM_FIXTURES_DIR: scratchRoot } },
      );
      const degradedStop = async (): Promise<void> => {
        spawn('taskkill', ['/F', '/T', '/PID', String(degradedServer.pid)], { stdio: 'ignore' });
        await new Promise((r) => setTimeout(r, 800));
      };
      try {
        const deadline = Date.now() + 60_000;
        for (;;) {
          try {
            const res = await fetch(degradedBase, { signal: AbortSignal.timeout(1500) });
            if (res.ok) break;
          } catch {
            /* not up yet */
          }
          if (Date.now() > deadline) throw new Error('degraded server did not start');
          await new Promise((r) => setTimeout(r, 700));
        }
        const degradedContext = await browser.newContext({
          viewport: { width: 1280, height: 800 },
        });
        const degradedPage = await degradedContext.newPage();
        const degradedErrors: string[] = [];
        degradedPage.on('console', (msg) => {
          if (msg.type() === 'error') degradedErrors.push(msg.text());
        });

        const momentsRes = await degradedPage.goto(`${degradedBase}/moments`, {
          waitUntil: 'load',
        });
        const catalogUnavailable = await degradedPage
          .locator('.moments__empty')
          .innerText()
          .catch(() => '');
        await degradedPage.screenshot({
          path: path.join(OUT_DIR, 'screenshots', 'moments-degraded-1280x800.png'),
        });

        const exploreRes = await degradedPage.goto(`${degradedBase}/explore`, {
          waitUntil: 'load',
        });
        await degradedPage.waitForFunction(
          () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
          undefined,
          { timeout: 45_000 },
        );
        await degradedPage.waitForTimeout(800);
        const replayState = await degradedPage.evaluate(() => ({
          playhead: window.__kyneloomScene!.playheadMs(),
          players: window.__kyneloomScene!.snapshot().players.length,
        }));
        // A selection attempted against the invalid catalog degrades to the
        // honest notice — still no server error.
        const selectionRes = await degradedPage.goto(
          `${degradedBase}/explore?moment=ia-03-measured-checkpoint`,
          { waitUntil: 'load' },
        );
        const noticeShown = await degradedPage
          .locator('[data-unknown-moment]')
          .first()
          .isVisible()
          .catch(() => false);

        const degradedOk =
          momentsRes?.status() === 200 &&
          catalogUnavailable.toLowerCase().includes('catalog unavailable') &&
          exploreRes?.status() === 200 &&
          replayState.playhead === 4_722_100 &&
          replayState.players === 22 &&
          selectionRes?.status() === 200 &&
          noticeShown &&
          degradedErrors.length === 0;
        if (!degradedOk) {
          failures.push(
            `degraded fixture: moments ${String(momentsRes?.status())}, explore ${String(exploreRes?.status())}, replay ${JSON.stringify(replayState)}, notice ${String(noticeShown)}, console errors ${String(degradedErrors.length)}`,
          );
        }
        results.push({
          route: 'moments-degraded',
          viewport: '1280x800',
          reducedMotion: false,
          screenshot: 'screenshots/moments-degraded-1280x800.png',
          horizontalOverflowPx: 0,
          consoleErrors: degradedErrors,
          checks: {
            momentsStatus: momentsRes?.status() ?? 0,
            catalogUnavailable: catalogUnavailable.toLowerCase().includes('catalog unavailable'),
            exploreStatus: exploreRes?.status() ?? 0,
            defaultReplay: JSON.stringify(replayState),
            selectionStatus: selectionRes?.status() ?? 0,
            selectionNotice: noticeShown,
          },
        });
        await degradedContext.close();
      } finally {
        await degradedStop();
        rmSync(scratchRoot, { recursive: true, force: true });
      }
    }
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
