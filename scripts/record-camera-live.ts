/**
 * KYN-07 evidence recorder (real-time camera rig): `pnpm qa:record:camera`
 *
 * Records a CONTINUOUS, real-time 30 fps screencast of the elastic camera
 * rig demonstrating the Issue #7 acceptance sequence:
 *
 *   overhead tactical view → smooth descent into the winger-follow camera
 *   (behind home-11) → goalkeeper perspective (from the engaged keeper's
 *   actual position) → an INTERRUPTED transition (rapid mode change
 *   mid-flight) → the manifest-DIRECTED shot-to-goal composition ending on
 *   the goalmouth at 4728300 ms → exit directed mode.
 *
 * Same proven pipeline as KYN-06's `qa:record:live`: headed GPU Chromium
 * in a fixed window region captured with ffmpeg gdigrab (in-browser
 * screencast APIs write blank files on this host), fast H.264 capture,
 * offline WebM twin, ffmpeg-verified motion, 8–15 s envelope.
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 3176;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('qa', 'video');
const VIDEO_NAME = 'camera-rig-screencast.mp4';
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
  if (process.platform !== 'win32') {
    throw new Error('the camera rig recorder uses ffmpeg gdigrab (Windows desktop capture)');
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
  const rawPath = path.join(OUT_DIR, 'camera-rig-screencast-raw.mp4');
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

    const seek = async (ms: number) => {
      await page.locator('.stage__slider').evaluate((el, value) => {
        const input = el as HTMLInputElement;
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, ms);
      await page.waitForTimeout(250);
    };
    const cam = (name: string) => page.getByRole('radio', { name }).click({ force: true });

    // Frame the sequence from the checkpoint with the playhead advancing.
    await page.getByRole('button', { name: /Reset to checkpoint/ }).click();
    await page.locator('.stage__play').click();
    await page.waitForTimeout(900); // play running under BROADCAST first

    // Capture starts on the overhead tactical view.
    await cam('Overhead');
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

    // ~12.5 s of real-time rig behavior (match time keeps advancing at 1×).
    await page.waitForTimeout(1300); // overhead hold
    await cam('Follow'); // smooth descent behind home-11
    await page.waitForTimeout(2600);
    await cam('Goalkeeper'); // the engaged keeper's perspective
    await page.waitForTimeout(1900);
    await cam('Broadcast'); // INTERRUPT the keeper transition mid-flight
    await page.waitForTimeout(700);
    await cam('Directed'); // guided shot → goal composition
    await seek(4_727_000); // just before the shot (local offset ~10.0 s)
    await page.waitForTimeout(600);
    await page.locator('.stage__play').click(); // ensure playing through the goal
    await page.waitForTimeout(2700); // shot 4727800 → GOAL 4728300 → aftermath
    await page.locator('.stage__play').click(); // pause on the goalmouth
    await page.waitForTimeout(1200);
    await cam('Broadcast'); // exit directed mode, spring resumes
    await page.waitForTimeout(1100);

    stats.players = await page.evaluate(() => {
      const w = window as { __kyneloomScene?: { snapshot(): { players: unknown[] } } };
      return w.__kyneloomScene?.snapshot().players.length ?? null;
    });
    await context.close();
  } finally {
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

  execSync(
    `"${ffmpeg}" -y -i "${rawPath}" -c:v libvpx -b:v 3000k -an "${path.join(OUT_DIR, 'camera-rig-screencast.webm')}"`,
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
