/**
 * KYN-10 gallery recorder: `pnpm qa:record:gallery`
 *
 * Records the CONTINUOUS discovery→replay journey, real-time, from the
 * browser compositor's own frame stream (CDP Page.startScreencast, occlusion
 * throttling disabled — the same honest method as the KYN-08 xray recorder;
 * host screen capture is unavailable on this host):
 *
 *   open /moments → featured moment (real motion preview) → scroll to the
 *   collection → hover a chapter card (tilt + reveal) → select a DIFFERENT
 *   chapter card → arrive in the actual 3D Living Replay at that chapter's
 *   timestamp → change camera → Evidence X-Ray with the honest
 *   outside-measured-interval note → go to the measured interval →
 *   open the evidence inspector (source frames) → back to the replay.
 *
 * Every frame is the exact composited page (WebGL included); frames are
 * assembled at the measured rate into H.264 MP4 + a WebM twin, with an
 * ffmpeg-verified motion check. No step is scripted screenshots — it is one
 * unbroken capture of the real interaction.
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

const PORT = 3181;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('qa', 'video');
const FRAME_DIR = path.join(OUT_DIR, 'gallery-frames');
const VIDEO_NAME = 'gallery-screencast.mp4';
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
  const stats: { players: number | null; chapters: number | null } = {
    players: null,
    chapters: null,
  };
  const frameTimes: number[] = [];
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    // 1. Open the gallery.
    await page.goto(`${BASE}/moments`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (window as { __kyneloomMoments?: unknown }).__kyneloomMoments !== undefined,
      undefined,
      { timeout: 20_000 },
    );
    stats.chapters = await page.evaluate(
      () =>
        (window as { __kyneloomMoments?: { count(): number } }).__kyneloomMoments?.count() ?? null,
    );

    // Compositor frame stream for the whole journey.
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

    // 2. Inspect the featured moment (real motion preview breathing).
    await page.waitForTimeout(2600);

    // 3. Browse down to the collection; hover a source-backed card so the
    //    tilt + reveal is on camera.
    const firstCard = page.locator('.mcard').first();
    await firstCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    const cardBox = await firstCard.boundingBox();
    if (cardBox !== null) {
      await page.mouse.move(cardBox.x + cardBox.width * 0.62, cardBox.y + cardBox.height * 0.35, {
        steps: 12,
      });
    }
    await page.waitForTimeout(1400);

    // 4. Select a DIFFERENT chapter (the equalizer, 78:48.3) — a real click.
    const goalCard = page.locator('[data-catalog-id="ia-10-the-equalizer"]');
    await goalCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await goalCard.click();

    // 5. Arrive in the actual 3D replay at that chapter's timestamp.
    await page.waitForFunction(
      () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
      undefined,
      { timeout: 45_000 },
    );
    await page.waitForTimeout(2200); // scene settles on camera; chapter chip visible

    // 6. Change camera — overhead tactical view.
    await page.getByRole('radio', { name: 'Overhead' }).click({ force: true });
    await page.waitForTimeout(1600);

    // 7. Inspect evidence: X-Ray while the playhead sits OUTSIDE the
    //    measured interval (78:48.3) — the honest contextual note appears;
    //    jumping to the measured interval grounds the geometry.
    await page.getByRole('button', { name: 'X-Ray' }).click();
    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: 'Go to measured interval' }).click();
    await page.waitForTimeout(1400);
    await page.getByRole('button', { name: 'Show evidence' }).click();
    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: 'Show source frames' }).click();
    await page.waitForTimeout(1300);

    // 8. Back to the living replay.
    await page.getByRole('button', { name: 'Back to replay' }).click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: 'X-Ray' }).click(); // off
    await page.getByRole('radio', { name: 'Broadcast' }).click({ force: true });
    await page.waitForTimeout(1100);

    await cdp.send('Page.stopScreencast');
    stats.players = await page.evaluate(() => {
      const w = window as { __kyneloomScene?: { snapshot(): { players: unknown[] } } };
      return w.__kyneloomScene?.snapshot().players.length ?? null;
    });
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

  const rawPath = path.join(OUT_DIR, 'gallery-screencast-raw.mp4');
  execSync(
    `"${ffmpeg}" -y -framerate ${measuredFps.toFixed(3)} -i "${path.join(FRAME_DIR, 'f%05d.jpg')}" ` +
      `-vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -an "${rawPath}"`,
    { stdio: 'pipe' },
  );
  execSync(
    `"${ffmpeg}" -y -i "${rawPath}" -c:v libvpx -b:v 3000k -an "${path.join(OUT_DIR, 'gallery-screencast.webm')}"`,
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
    `  chapters in gallery: ${JSON.stringify(stats.chapters)} · players live at final frame: ${JSON.stringify(stats.players)}`,
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
