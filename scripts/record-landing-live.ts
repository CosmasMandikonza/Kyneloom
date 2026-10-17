/**
 * KYN-09 landing recorder: `pnpm qa:record:landing`
 *
 * Records a CONTINUOUS, real-time capture of the full signature entry:
 * landing orb idle → Enter the moment → intro → fragment morph → pitch
 * reveal → handoff into the REAL Living Replay → moving players → camera
 * switch → Evidence X-Ray. Capture method (disclosed honestly): the browser
 * compositor's own frame stream via CDP `Page.startScreencast` — the proven
 * pipeline from the other Kyneloom recorders (screen capture is unavailable
 * on this host; see qa/README.md). Assembled at the measured rate into an
 * H.264 MP4 + WebM twin with an ffmpeg-verified motion gate and the 8–15 s
 * envelope.
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

const PORT = 3178;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('qa', 'video');
const FRAME_DIR = path.join(OUT_DIR, 'landing-frames');
const VIDEO_NAME = 'landing-entry-screencast.mp4';
const FPS_CAP = 30;

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
      '--window-position=50,40',
      '--window-size=1460,960',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
  const stats: { players: number | null; playhead: number | null } = {
    players: null,
    playhead: null,
  };
  const frameTimes: number[] = [];
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () =>
        (window as { __kyneloomLanding?: unknown }).__kyneloomLanding !== undefined &&
        document.querySelectorAll('canvas').length > 0,
      undefined,
      { timeout: 45_000 },
    );

    // Compositor frame stream — every composited frame of the page.
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

    // The judge's entry, in order: orb breathes, then the moment unlocks.
    await page.waitForTimeout(1500); // idle — orb intro settles
    await page.getByTestId('enter-the-moment').click();
    await page.waitForTimeout(5200); // intro + fragment morph + reveal

    // The handoff lands in the REAL replay; keep it alive and interactive.
    await page.waitForFunction(
      () => (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
      undefined,
      { timeout: 45_000 },
    );
    await page.waitForTimeout(1100); // overhead → broadcast sweep + fade-in
    await page.locator('.stage__play').click();
    await page.waitForTimeout(1000); // 22 footballers playing
    await page.getByRole('radio', { name: 'Follow' }).click({ force: true });
    await page.waitForTimeout(1000); // follow the runner
    await page.locator('.stage__slider').focus();
    await page.keyboard.press('x'); // Evidence X-Ray
    await page.waitForTimeout(1200);

    await cdp.send('Page.stopScreencast');
    stats.players = await page.evaluate(() => {
      const w = window as { __kyneloomScene?: { snapshot(): { players: unknown[] } } };
      return w.__kyneloomScene?.snapshot().players.length ?? null;
    });
    stats.playhead = await page.evaluate(() => {
      const w = window as { __kyneloomScene?: { playheadMs(): number } };
      return w.__kyneloomScene?.playheadMs() ?? null;
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
  const measuredFps = Math.min(
    FPS_CAP,
    Math.max(10, (frameCount - 1) / Math.max(captureSeconds, 0.1)),
  );

  const rawPath = path.join(OUT_DIR, 'landing-entry-raw.mp4');
  execSync(
    `"${ffmpeg}" -y -framerate ${measuredFps.toFixed(3)} -i "${path.join(FRAME_DIR, 'f%05d.jpg')}" ` +
      `-vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -an "${rawPath}"`,
    { stdio: 'pipe' },
  );
  execSync(
    `"${ffmpeg}" -y -i "${rawPath}" -c:v libvpx -b:v 3000k -an "${path.join(OUT_DIR, 'landing-entry-screencast.webm')}"`,
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
  console.log(`  replay after handoff: ${JSON.stringify(stats)}`);
  console.log(`  max adjacent-frame motion: ${maxMotion.toFixed(2)} Y-units`);
  rmSync(FRAME_DIR, { recursive: true, force: true });
  if (maxMotion < 0.5) {
    console.error('FAIL: screencast frames do not vary — blank capture');
    process.exit(1);
  }
  if (durationS < 8 || durationS > 15) {
    console.error(`FAIL: screencast duration ${durationS.toFixed(1)}s outside the 8-15s envelope`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
