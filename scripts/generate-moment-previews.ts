/**
 * KYN-10 offline preview pipeline: `pnpm moments:previews`
 *
 * Generates the gallery's scene-derived imagery from the REAL product:
 * boots the production web app, opens the actual Living Replay at each
 * catalog chapter's validated timestamp (`/explore?moment=<id>` — the same
 * seam visitors use), switches to the chapter's deliberate camera, waits
 * for the rig to converge, and captures the live WebGL canvas element.
 * Nothing is drawn by this script; every pixel comes from the scene
 * renderer driven by accepted tracking at the exact focus frame.
 *
 * Provenance is persisted next to the images in
 * `apps/web/public/moment-previews/manifest.json` (match id, timestamp,
 * camera, capture method, fixture hashes) and rendered by the gallery.
 *
 * The featured motion preview is a continuous capture of the playing scene
 * (decoy-run window, follow camera) from the browser compositor's own frame
 * stream (CDP Page.startScreencast) — the same honest method as the KYN-08
 * xray recorder — assembled into H.264 MP4 with ffmpeg.
 */
import { execSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { loadGoldenMatch } from '../apps/web/src/lib/match-fixture';
import { buildMomentCatalog } from '../apps/web/src/lib/moment-catalog';

const PORT = 3179;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('apps', 'web', 'public', 'moment-previews');
const FRAME_DIR = path.join(OUT_DIR, '.motion-frames');
/** Viewport chosen so the stage canvas lands close to 16:9 (width/44rem cap). */
const CAPTURE_VIEWPORT = { width: 1280, height: 1240 } as const;
/** End of the verified measurement interval — where the featured motion stops. */
const MEASURED_WINDOW_END = 4_724_000;
const CAMERA_LABELS: Record<string, string> = {
  broadcast: 'Broadcast',
  overhead: 'Overhead',
  follow: 'Follow',
  goalkeeper: 'Goalkeeper',
  directed: 'Directed',
};
/**
 * Floating stage chrome hidden while capturing so each preview is a clean
 * PLATE of the scene itself. The renderer, playhead and camera are the
 * untouched product — only the DOM overlays that sit on top of the canvas
 * are display:none'd for the shot (documented in the manifest method).
 */
const HIDE_CHROME_CSS =
  [
    '.site-header',
    '.stage__context',
    '.stage__modes',
    '.stage__status',
    '.stage__evidence-context',
    '.stage__xray-2d',
    '.stage__loading',
  ].join(', ') + ' { display: none !important; }';

function resolveFfmpeg(): string {
  const candidates = [
    process.env.KYN_FFMPEG,
    path.resolve('.tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    'ffmpeg',
  ].filter((c): c is string => !!c);
  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') return candidate;
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('ffmpeg not found (KYN_FFMPEG / .tools/ffmpeg / PATH)');
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
    if (Date.now() > deadline) throw new Error(`server did not start:\n${stdout.join('')}`);
    await new Promise((r) => setTimeout(r, 700));
  }
  return async () => {
    if (process.platform === 'win32') {
      // `next start` outlives the pnpm wrapper's tree on Windows — kill the
      // wrapper tree AND any process still listening on the port.
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 800));
      try {
        const out = execSync('netstat -ano').toString();
        const pids = [
          ...new Set(
            out
              .split('\n')
              .filter((line) => line.includes(`:${PORT}`) && line.includes('LISTENING'))
              .map((line) => line.trim().split(/\s+/).at(-1))
              .filter((pid): pid is string => !!pid && pid !== '0'),
          ),
        ];
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /T /PID ${pid}`);
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* netstat scrape failed; tree kill already attempted */
      }
    } else {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
    }
  };
}

interface SceneHook {
  playheadMs: () => number;
  visual?: { cameraWorldPosition: () => readonly number[] | null };
}

/**
 * Capture the featured motion preview in a dedicated browser instance:
 * open the featured chapter, follow camera, seek to the measured-interval
 * start via the REAL transport slider, then compositor-capture the playing
 * scene until the interval ends. Writes JPEG frames + a timing file.
 */
async function captureFeaturedMotion(
  base: string,
  focusMs: number,
  forceHeadless = false,
): Promise<{ fps: number }> {
  const browser = await chromium.launch({
    headless: forceHeadless,
    ...(forceHeadless
      ? {}
      : {
          args: [
            '--window-position=80,60',
            '--window-size=1180,900',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--disable-features=CalculateNativeWinOcclusion',
          ],
        }),
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1120, height: 840 } });
    const page = await context.newPage();
    await page.goto(`${base}/explore?moment=ia-00-invisible-assist`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => !!(window as { __kyneloomScene?: unknown }).__kyneloomScene,
      undefined,
      { timeout: 45_000 },
    );
    await page.getByRole('radio', { name: 'Follow', exact: true }).click();
    await page.locator('.stage__slider').evaluate((slider, value) => {
      (slider as HTMLInputElement).value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, focusMs);
    await waitForCamera(page);
    await page.addStyleTag({ content: HIDE_CHROME_CSS });
    await page.waitForTimeout(250);

    const frameTimes: number[] = [];
    const cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', (event) => {
      const n = frameTimes.length;
      writeFileSync(
        path.join(FRAME_DIR, `f${String(n).padStart(5, '0')}.jpg`),
        Buffer.from(event.data, 'base64'),
      );
      frameTimes.push(Date.now());
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 82,
      everyNthFrame: 1,
      maxWidth: 960,
      maxHeight: 720,
    });
    await page.locator('.stage__play').click();
    const runMs = MEASURED_WINDOW_END - focusMs;
    await page.waitForTimeout(runMs + 700);
    await cdp.send('Page.stopScreencast');
    await page.locator('.stage__play').click(); // pause
    await context.close();

    if (frameTimes.length < 2) throw new Error('compositor stream produced no frames');
    writeFileSync(
      path.join(OUT_DIR, '.motion-timing.json'),
      JSON.stringify({ spanMs: frameTimes.at(-1)! - frameTimes[0]! }),
    );
    return { fps: (frameTimes.length - 1) / ((frameTimes.at(-1)! - frameTimes[0]!) / 1000) };
  } finally {
    await browser.close();
  }
}

/** Wait until the camera rig has converged (position stable across polls). */
async function waitForCamera(page: Page, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous: readonly number[] | null = null;
  for (;;) {
    const pos = await page.evaluate(() => {
      const hook = (window as { __kyneloomScene?: SceneHook }).__kyneloomScene;
      return hook?.visual?.cameraWorldPosition() ?? null;
    });
    if (
      pos !== null &&
      previous !== null &&
      pos.length === 3 &&
      previous.length === 3 &&
      Math.hypot(
        (pos[0] ?? 0) - (previous[0] ?? 0),
        (pos[1] ?? 0) - (previous[1] ?? 0),
        (pos[2] ?? 0) - (previous[2] ?? 0),
      ) < 0.05
    ) {
      return;
    }
    previous = pos;
    if (Date.now() > deadline) throw new Error('camera did not converge in time');
    await page.waitForTimeout(180);
  }
}

async function main(): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  const golden = await loadGoldenMatch();
  if (!golden.ok) throw new Error(`golden fixture unavailable: ${golden.message}`);
  const catalog = buildMomentCatalog(golden);
  if (catalog === null) throw new Error('catalog could not be built');
  const entries = [catalog.featured, ...catalog.chapters];

  mkdirSync(OUT_DIR, { recursive: true });
  const metadata = JSON.parse(
    readFileSync('tests/fixtures/generated/synthetic-derby-01/metadata.json', 'utf-8'),
  ) as { integrity?: { events?: string; tracking?: string } };

  const stopServer = await startServer();
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: CAPTURE_VIEWPORT });
      const previews: {
        catalogId: string;
        file: string;
        focusMs: number;
        camera: string;
        width: number;
        height: number;
      }[] = [];

      // A FRESH PAGE per capture: each /explore mount owns a WebGL context;
      // reusing one page across 13 navigations accumulates renderer state on
      // software GPUs and eventually stalls. Close as soon as the shot lands.
      for (const entry of entries) {
        const page = await context.newPage();
        page.on('console', (message) => {
          if (message.type() === 'error') console.warn(`[browser console.error] ${message.text()}`);
        });
        const startedAt = Date.now();
        const url = `${BASE}/explore?moment=${entry.catalogId}`;
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(
          () => {
            const canvas = document.querySelector('canvas');
            return (
              !!(window as { __kyneloomScene?: unknown }).__kyneloomScene &&
              !!canvas &&
              canvas.width > 300
            );
          },
          undefined,
          { timeout: 45_000 },
        );
        const playhead = await page.evaluate(
          () => (window as { __kyneloomScene?: SceneHook }).__kyneloomScene?.playheadMs() ?? null,
        );
        if (playhead !== entry.focusMs) {
          throw new Error(
            `${entry.catalogId}: scene playhead ${String(playhead)} != focus ${entry.focusMs}`,
          );
        }
        const label = CAMERA_LABELS[entry.previewCamera];
        if (label === undefined) throw new Error(`no label for camera ${entry.previewCamera}`);
        await page.getByRole('radio', { name: label, exact: true }).click();
        await waitForCamera(page);
        await page.addStyleTag({ content: HIDE_CHROME_CSS });
        await page.waitForTimeout(350); // settle frames after convergence
        const canvas = page.locator('canvas').first();
        const file = `${entry.catalogId}.png`;
        await canvas.screenshot({ path: path.join(OUT_DIR, file) });
        const box = await canvas.boundingBox();
        previews.push({
          catalogId: entry.catalogId,
          file,
          focusMs: entry.focusMs,
          camera: entry.previewCamera,
          width: Math.round(box?.width ?? 0),
          height: Math.round(box?.height ?? 0),
        });
        console.log(
          `captured ${entry.catalogId} @ ${entry.focusMs} (${entry.previewCamera}, ${String(box?.width ?? 0)}x${String(box?.height ?? 0)}) in ${Date.now() - startedAt}ms`,
        );
        await page.close();
      }

      // Featured motion preview: continuous compositor capture of the playing
      // scene across the decoy-run window, follow camera. Captured in a
      // HEADED GPU browser (software headless composites at ~8 fps, too slow
      // for real motion); falls back to headless when no display exists.
      rmSync(FRAME_DIR, { recursive: true, force: true });
      mkdirSync(FRAME_DIR, { recursive: true });
      let motionFps = 0;
      let motionHeaded = true;
      try {
        const motion = await captureFeaturedMotion(BASE, catalog.featured.focusMs);
        motionFps = motion.fps;
      } catch (headedError) {
        console.warn(
          `headed motion capture failed (${headedError instanceof Error ? headedError.message : String(headedError)}) — retrying headless`,
        );
        motionHeaded = false;
        const motion = await captureFeaturedMotion(BASE, catalog.featured.focusMs, true);
        motionFps = motion.fps;
      }
      const frameCount = readdirSync(FRAME_DIR).filter((f) => f.endsWith('.jpg')).length;
      const motionFile = 'ia-00-motion.mp4';
      if (frameCount < 8) throw new Error(`motion capture too short: ${frameCount} frames`);
      // True frame timing from the capture timestamps recorded by the helper.
      const timing = JSON.parse(
        readFileSync(path.join(OUT_DIR, '.motion-timing.json'), 'utf-8'),
      ) as {
        spanMs: number;
      };
      const fps = Math.min(60, Math.max(8, (frameCount - 1) / Math.max(timing.spanMs / 1000, 0.1)));
      execSync(
        `"${ffmpeg}" -y -framerate ${fps.toFixed(3)} -i "${path.join(FRAME_DIR, 'f%05d.jpg')}" ` +
          `-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart -an "${path.join(OUT_DIR, motionFile)}"`,
        { stdio: 'pipe' },
      );
      void motionFps;

      const manifest = {
        schemaVersion: '1.0',
        generator: 'kyneloom-preview-pipeline/2',
        method:
          'Playwright capture of the live R3F WebGL canvas on /explore?moment=<catalogId>, paused at each chapter’s validated focus timestamp, deliberate camera per entry, rig converged before capture; floating stage chrome display:none’d for a clean plate — scene pixels are the untouched product renderer',
        matchId: catalog.matchId,
        generatedAt: new Date().toISOString(),
        fixture: {
          seed: golden.data.seed,
          generatorVersion: golden.data.generatorVersion,
          eventsSha256: metadata.integrity?.events ?? null,
          trackingSha256: metadata.integrity?.tracking ?? null,
        },
        capture: { viewport: CAPTURE_VIEWPORT, browser: chromium.name(), headless: true },
        previews,
        motion: {
          catalogId: catalog.featured.catalogId,
          file: motionFile,
          poster: `${catalog.featured.catalogId}.png`,
          fromMs: catalog.featured.focusMs,
          toMs: MEASURED_WINDOW_END,
          camera: 'follow',
          measuredFps: Number(fps.toFixed(2)),
          headed: motionHeaded,
          method:
            'continuous browser-compositor frame capture (CDP Page.startScreencast) of the playing scene — genuine motion from accepted tracking, assembled with ffmpeg',
        },
      };
      writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      rmSync(FRAME_DIR, { recursive: true, force: true });

      const bytes = statSync(path.join(OUT_DIR, motionFile)).size;
      console.log(
        `featured motion: ${motionFile} (${(bytes / 1024 / 1024).toFixed(2)} MB, ${fps.toFixed(1)} fps measured, ${frameCount} frames, ${motionHeaded ? 'headed GPU' : 'headless software'})`,
      );
      console.log(`manifest written with ${previews.length} previews`);
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await stopServer();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
