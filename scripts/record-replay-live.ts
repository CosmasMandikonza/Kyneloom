/**
 * KYN-06 evidence recorder (real-time): `pnpm qa:record:live`
 *
 * Records a CONTINUOUS, real-time browser screencast of the golden replay
 * sequence — checkpoint freeze → decoy run + pass (broadcast) → pause →
 * scrub back → player-follow camera → shot + goal at 4728300 → aftermath —
 * on the machine GPU (headed Chromium ~50 fps), captured at 30 fps with
 * ffmpeg's Windows screen grabber (gdigrab) over exactly the browser window
 * region. Unlike this host's broken in-browser screencast paths (which write
 * blank constant-luminance WebM), every frame here is composited by Windows
 * itself.
 *
 * Output: qa/video/living-replay-screencast.mp4 (8–15 s, H.264). Live VP8
 * encoding cannot keep up with 30 fps capture on this machine (frames drop),
 * so the recorder captures with fast H.264 first and then transcodes a
 * WebM twin (living-replay-screencast.webm) offline. The script self-checks
 * adjacent-frame motion with ffmpeg signalstats and fails loudly on a blank
 * capture.
 *
 * Requirements: a production build (`pnpm build`), a Windows session with an
 * interactive desktop (gdigrab), and an ffmpeg binary — `KYN_FFMPEG` env
 * var, `.tools/ffmpeg.exe`, or `ffmpeg` on PATH.
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 3175;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('qa', 'video');
const VIDEO_NAME = 'living-replay-screencast.mp4';
/** Browser window placement — the gdigrab region maps 1:1 onto it. */
const WIN = { x: 50, y: 40, w: 1460, h: 960 } as const;
const FPS = 30;

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
  throw new Error(
    'ffmpeg not found: set KYN_FFMPEG, place a binary at .tools/ffmpeg(.exe), or put ffmpeg on PATH',
  );
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

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('the live screencast recorder uses ffmpeg gdigrab (Windows desktop capture)');
  }
  const ffmpeg = resolveFfmpeg();
  mkdirSync(OUT_DIR, { recursive: true });
  const stopServer = await startServer();
  const videoPath = path.join(OUT_DIR, VIDEO_NAME);

  const browser = await chromium.launch({
    headless: false,
    args: [`--window-position=${WIN.x},${WIN.y}`, `--window-size=${WIN.w},${WIN.h}`],
  });
  const stats: { players: number | null } = { players: null };
  const rawPath = path.join(OUT_DIR, 'living-replay-screencast-raw.mp4');
  let recorder: ReturnType<typeof spawn> | null = null;
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(`${BASE}/explore`, { waitUntil: 'load' });
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

    // Settle the window fully inside the capture region, THEN start the
    // capture: the envelope is 8-15 s of the sequence itself (load-time
    // evidence lives in the stepped capture and qa/report.json).
    await page.waitForTimeout(1200);
    recorder = spawn(
      ffmpeg,
      [
        '-y',
        '-f',
        'gdigrab',
        '-framerate',
        String(FPS),
        '-offset_x',
        String(WIN.x),
        '-offset_y',
        String(WIN.y),
        '-video_size',
        `${WIN.w}x${WIN.h}`,
        '-i',
        'desktop',
        // Fast H.264 for capture (VP8 cannot encode 30 fps live here; a slow
        // consumer makes gdigrab drop frames). Transcoded to WebM afterwards.
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-an',
        rawPath,
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );

    // Real-time golden sequence on the GPU browser (~11.5 s wall).
    const seek = async (ms: number) => {
      await page.locator('.stage__slider').evaluate((el, value) => {
        const input = el as HTMLInputElement;
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, ms);
      await page.waitForTimeout(250);
    };
    await page.getByRole('button', { name: /Reset to checkpoint/ }).click();
    await page.waitForTimeout(900); // beat on the checkpoint freeze
    await page.locator('.stage__play').click();
    await page.waitForTimeout(4200); // decoy run → pass released (broadcast)
    await page.locator('.stage__play').click(); // pause
    await page.waitForTimeout(600);
    await seek(4723900); // scrub back to just before the pass
    await page.getByRole('radio', { name: 'Follow' }).click();
    await page.waitForTimeout(700); // camera transition
    await page.locator('.stage__play').click();
    await page.waitForTimeout(4800); // threaded pass, shot, GOAL + aftermath
    await page.locator('.stage__play').click(); // pause on the aftermath
    await page.waitForTimeout(900);

    stats.players = await page.evaluate(() => {
      const w = window as { __kyneloomScene?: { snapshot(): { players: unknown[] } } };
      return w.__kyneloomScene?.snapshot().players.length ?? null;
    });
    await context.close();
  } finally {
    // Graceful stop lets ffmpeg finalize the container index.
    if (recorder !== null) {
      const active = recorder;
      active.stdin?.write('q');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 8000);
        active.once('exit', () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
    }
    await browser.close();
    await stopServer();
  }

  // Offline twin: same footage as WebM for the web-first evidence set.
  execSync(
    `"${ffmpeg}" -y -i "${rawPath}" -c:v libvpx -b:v 3000k -an "${path.join(OUT_DIR, 'living-replay-screencast.webm')}"`,
    {
      stdio: 'pipe',
    },
  );
  renameSync(rawPath, videoPath);

  // Self-check: adjacent frames must differ (motion), never a blank capture.
  const diffs = execSync(
    `"${ffmpeg}" -i "${videoPath}" -vf "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -`,
    { stdio: 'pipe' },
  )
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('lavfi.signalstats.YAVG='))
    .map((l) => Number(l.slice('lavfi.signalstats.YAVG='.length)));
  const maxMotion = Math.max(0, ...diffs);
  const frameCount = diffs.length + 1;
  const durationS = frameCount / FPS;
  const bytes = statSync(videoPath).size;

  console.log(`recorded ${VIDEO_NAME} (continuous ${FPS} fps gdigrab screencast)`);
  console.log(`  duration: ${durationS.toFixed(1)}s (${frameCount} frames)`);
  console.log(`  size: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  players live at final frame: ${JSON.stringify(stats.players)}`);
  console.log(`  max adjacent-frame motion: ${maxMotion.toFixed(2)} Y-units`);
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
