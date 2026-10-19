/**
 * KYN-11 lens journey recorder: `pnpm qa:record:lens`
 *
 * Records the CONTINUOUS acceptance journey, real-time, from the browser
 * compositor's own frame stream (CDP Page.startScreencast, occlusion
 * throttling disabled — the same honest capture method as the other
 * Kyneloom recorders):
 *
 *   open a moment from the gallery → cinematic FAN replay → select the
 *   winger, pause at 78:42 → Explain (ANALYST at the same instant, same
 *   selection) → X-Ray geometry → source frames → ACCESSIBLE spatial
 *   description + transcript navigation → back to FAN at the exact same
 *   playhead.
 */
import { spawn, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 3187;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('qa', 'video');
const FRAME_DIR = path.join(OUT_DIR, 'lens-frames');
const VIDEO_NAME = 'lens-journey-screencast.mp4';
const WIN = { x: 50, y: 40, w: 1460, h: 960 } as const;

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
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 800));
    } else {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
    }
  };
}

async function main(): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(FRAME_DIR, { recursive: true, force: true });
  mkdirSync(FRAME_DIR, { recursive: true });
  const stopServer = await startServer();
  const videoPath = path.join(OUT_DIR, VIDEO_NAME);

  const browser = await chromium.launch({
    headless: false,
    args: [
      `--window-position=${WIN.x},${WIN.y}`,
      `--window-size=${WIN.w},${WIN.h}`,
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
  const stats: { finalPlayhead: number | null; finalLens: string | null } = {
    finalPlayhead: null,
    finalLens: null,
  };
  const frameTimes: number[] = [];
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    // 1. Open a moment from the gallery (chapter 4 — top speed).
    await page.goto(`${BASE}/moments`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (window as { __kyneloomMoments?: unknown }).__kyneloomMoments !== undefined,
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(1200);

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
      quality: 75,
      everyNthFrame: 1,
      maxWidth: 1280,
      maxHeight: 832,
    });

    await page.locator('[data-catalog-id="ia-03-measured-checkpoint"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.locator('[data-catalog-id="ia-03-measured-checkpoint"]').click();
    await page.waitForFunction(
      () => (window as { __kyneloomLens?: unknown }).__kyneloomLens !== undefined,
      undefined,
      { timeout: 45_000 },
    );

    // 2. Fan cinematic replay: play a moment, then pause at 78:42.
    await page.locator('.stage__play').click();
    await page.waitForTimeout(2600);
    await page.locator('.stage__play').click(); // pause mid-run
    await page.waitForTimeout(500);
    // Select the winger deterministically: click home-11's live projection.
    const target = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const scene = window.__kyneloomScene;
      if (canvas === null || scene === undefined) return null;
      const snap = scene.snapshot();
      const player = snap.players.find((q) => q.entityId === 'home-11');
      const project = scene.visual?.projectWorld;
      if (player === undefined || project === undefined) return null;
      const screen = project(player.xM, player.zM, -player.yM);
      if (screen === null) return null;
      const box = canvas.getBoundingClientRect();
      return { x: box.left + screen[0], y: box.top + screen[1] };
    });
    if (target !== null) {
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(600);
    }

    // 3. Explain → Analyst at the same instant.
    await page.getByTestId('fan-explain').click();
    await page.waitForTimeout(1400);
    await page.getByRole('button', { name: 'Show X-Ray' }).click();
    await page.waitForTimeout(1400);
    await page.getByRole('button', { name: 'Source evidence' }).click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: 'Show source frames' }).click();
    await page.waitForTimeout(1300);
    await page.getByRole('button', { name: 'Back to replay' }).click();
    await page.waitForTimeout(600);
    // X-Ray is still ON after returning — the button now reads 'X-Ray on'.
    await page.getByRole('button', { name: /X-Ray on/ }).click();

    // 4. Accessible: description + transcript navigation.
    await page.getByRole('radio', { name: 'Accessible', exact: true }).click();
    await page.waitForTimeout(1600);
    await page.getByRole('button', { name: /GOAL · 78:48.3/ }).click();
    await page.waitForTimeout(1400);

    // 5. Back to Fan — the exact same moment.
    await page.getByRole('radio', { name: 'Fan', exact: true }).click();
    await page.waitForTimeout(1600);

    await cdp.send('Page.stopScreencast');
    const finalState = await page.evaluate(() => ({
      playhead: window.__kyneloomLens!.playheadMs(),
      lens: window.__kyneloomLens!.lens(),
      selected: window.__kyneloomLens!.selected(),
    }));
    stats.finalPlayhead = finalState.playhead;
    stats.finalLens = finalState.lens;
    console.log(`final state: ${JSON.stringify(finalState)}`);
    await context.close();
  } finally {
    await browser.close();
    await stopServer();
  }

  const frameCount = readdirSync(FRAME_DIR).filter((f) => f.endsWith('.jpg')).length;
  if (frameCount !== frameTimes.length || frameCount < 2) {
    throw new Error(`compositor capture failed: ${String(frameCount)} frames on disk`);
  }
  const captureSeconds = (frameTimes.at(-1)! - frameTimes[0]!) / 1000;
  const measuredFps = Math.min(60, Math.max(10, (frameCount - 1) / Math.max(captureSeconds, 0.1)));

  const rawPath = path.join(OUT_DIR, 'lens-journey-raw.mp4');
  execSync(
    `"${ffmpeg}" -y -framerate ${measuredFps.toFixed(3)} -i "${path.join(FRAME_DIR, 'f%05d.jpg')}" ` +
      `-vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -an "${rawPath}"`,
    { stdio: 'pipe' },
  );
  execSync(
    `"${ffmpeg}" -y -i "${rawPath}" -c:v libvpx -b:v 3000k -an "${path.join(OUT_DIR, 'lens-journey-screencast.webm')}"`,
    { stdio: 'pipe' },
  );
  renameSync(rawPath, videoPath);

  const diffs = execSync(
    `"${ffmpeg}" -i "${videoPath}" -vf "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -`,
    { stdio: 'pipe' },
  )
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('lavfi.signalstats.YAVG='))
    .map((l) => Number(l.slice('lavfi.signalstats.YAVG='.length)));
  const maxMotion = Math.max(0, ...diffs);
  const outFrameCount = diffs.length + 1;
  const durationS = outFrameCount / measuredFps;
  const bytes = statSync(videoPath).size;

  console.log(
    `recorded ${VIDEO_NAME} (continuous compositor-frame capture, ${measuredFps.toFixed(1)} fps)`,
  );
  console.log(
    `  duration: ${durationS.toFixed(1)}s (${outFrameCount} frames from ${String(frameCount)} captured)`,
  );
  console.log(`  size: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(
    `  final playhead ${String(stats.finalPlayhead)} · final lens ${String(stats.finalLens)}`,
  );
  console.log(`  max adjacent-frame motion: ${maxMotion.toFixed(2)} Y-units`);
  rmSync(FRAME_DIR, { recursive: true, force: true });
  if (maxMotion < 0.5) {
    console.error('FAIL: screencast frames do not vary — blank capture');
    process.exit(1);
  }
  if (durationS < 15 || durationS > 60) {
    console.error(`FAIL: screencast duration ${durationS.toFixed(1)}s outside the 15-60s envelope`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
