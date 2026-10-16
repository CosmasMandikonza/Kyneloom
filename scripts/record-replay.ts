/**
 * KYN-06 evidence recorder: `pnpm qa:record`
 *
 * Records a REAL browser video of the Living Replay golden sequence:
 *
 *   checkpoint freeze → decoy run + pass release (broadcast camera) →
 *   pause + scrub back → player-follow camera → threaded pass, home-09's
 *   shot and the goal at 4728300 → paused aftermath.
 *
 * Why stepped capture: this host's browser screencast pipelines (Playwright
 * video headed/headless and the in-app-browser recorder) all produce blank
 * constant-luminance WebM files — verified with ffmpeg signalstats — and
 * live screenshots during software rendering wait on ~1 fps frame
 * production. So the recorder plays the sequence as a DETERMINISTIC
 * frame-step capture: the playhead is seeked through the window in exact
 * 250 ms increments (pause → seek → render → screenshot), and the frames
 * are assembled with ffmpeg at 4 fps, which presents true match speed.
 * Every output frame is a genuine rendered browser frame at a known,
 * reproducible playhead; the motion in the video is exactly the reducer's
 * truth for those timestamps.
 *
 * Requirements: a production build (`pnpm build`) and an ffmpeg binary —
 * `KYN_FFMPEG` env var, `.tools/ffmpeg.exe`, or `ffmpeg` on PATH.
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 3174;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('qa', 'video');
const FRAME_DIR = path.resolve('qa', 'video-frames');
const VIDEO_NAME = 'living-replay-800x600.webm';
const STEP_MS = 250;
const ENCODE_FPS = 1000 / STEP_MS;

function resolveFfmpeg(): string {
  const candidates = [
    process.env.KYN_FFMPEG,
    path.resolve('.tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    'ffmpeg',
  ].filter((c): c is string => !!c);
  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') return candidate; // defer to PATH at spawn time
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'ffmpeg not found: set KYN_FFMPEG, place a binary at .tools/ffmpeg(.exe), or put ffmpeg on PATH',
  );
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
    if (Date.now() > deadline) throw new Error(`server did not start:\n${stdout.join('')}`);
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

async function main(): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  mkdirSync(OUT_DIR, { recursive: true });
  const stopServer = await startServer();
  const browser = await chromium.launch({ headless: true });

  const stats: { players: number | null; playheads: number[] } = { players: null, playheads: [] };
  const jpegs: Buffer[] = [];
  try {
    // 800x600 keeps the desktop layout (>768px) with the transport visible.
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    // `load` (not networkidle): the explicit scene-ready wait below is the
    // real gate, and Chromium can idle-wait many seconds otherwise.
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
    };
    // Seek to an exact playhead, give the software renderer time to produce
    // the frame, then screenshot the real composited page.
    const frameAt = async (ms: number, settleMs = 1100) => {
      await seek(ms);
      await page.waitForTimeout(settleMs);
      jpegs.push(await page.screenshot({ type: 'jpeg', quality: 82 }));
      stats.playheads.push(ms);
    };

    // Sequence — matches the golden cinematic beat sheet (docs/15):
    await page.getByRole('button', { name: /Reset to checkpoint/ }).click();
    await frameAt(4722100, 800); // beat on the checkpoint freeze
    // Decoy run develops: home-11 runs, away-03 responds, pass released
    // (4724000) — broadcast camera.
    for (let t = 4722400; t <= 4726000; t += STEP_MS) await frameAt(t);
    await frameAt(4726000, 800); // hold the pause beat
    await seek(4723900); // scrub back to just before the pass release
    await page.getByRole('radio', { name: 'Follow' }).click();
    await page.waitForTimeout(600); // camera transition settles
    // Follow camera (behind home-11): threaded pass, home-09 shot, GOAL at
    // 4728300, celebration aftermath.
    for (let t = 4723900; t <= 4729250; t += STEP_MS) await frameAt(t);
    await frameAt(4729500, 800); // final pause on the aftermath

    stats.players = await page.evaluate(() => {
      const w = window as { __kyneloomScene?: { snapshot(): { players: unknown[] } } };
      return w.__kyneloomScene?.snapshot().players.length ?? null;
    });
    await context.close();
  } finally {
    await browser.close();
    await stopServer();
  }

  const { players } = stats;
  if (players === null || jpegs.length === 0) {
    throw new Error('recording finished without measurements — script bug');
  }

  // Write captured frames and assemble with ffmpeg at true-speed rate.
  rmSync(FRAME_DIR, { recursive: true, force: true });
  mkdirSync(FRAME_DIR, { recursive: true });
  jpegs.forEach((buf, i) => {
    writeFileSync(path.join(FRAME_DIR, `f${String(i).padStart(5, '0')}.jpg`), buf);
  });
  const videoPath = path.join(OUT_DIR, VIDEO_NAME);
  execSync(
    `"${ffmpeg}" -y -framerate ${ENCODE_FPS} -i "${path.join(FRAME_DIR, 'f%05d.jpg')}" ` +
      `-c:v libvpx -b:v 2500k -an "${videoPath}"`,
    { stdio: 'pipe' },
  );

  // Self-check: adjacent frames must DIFFER (motion). Whole-frame average
  // luminance is naturally stable on a dark page, so measure the difference
  // image between consecutive frames instead — this host's broken screencast
  // produced constant blanks and that must never pass silently again.
  const diffs = execSync(
    `"${ffmpeg}" -i "${videoPath}" -vf "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -`,
    { stdio: 'pipe' },
  )
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('lavfi.signalstats.YAVG='))
    .map((l) => Number(l.slice('lavfi.signalstats.YAVG='.length)));
  const maxMotion = Math.max(0, ...diffs);

  const bytes = statSync(videoPath).size;
  const videoDurationS = jpegs.length / ENCODE_FPS;
  const firstMs = stats.playheads[0] ?? 0;
  const lastMs = stats.playheads.at(-1) ?? 0;
  console.log(`recorded ${VIDEO_NAME}`);
  console.log(`  frames: ${jpegs.length} at ${STEP_MS} ms playhead steps → ${ENCODE_FPS} fps`);
  console.log(`  duration: ${videoDurationS.toFixed(1)}s (true match speed)`);
  console.log(`  playhead range: ${firstMs}–${lastMs} ms (checkpoint 4722100, goal 4728300)`);
  console.log(`  size: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  players live at final frame: ${JSON.stringify(players)}`);
  console.log(`  max adjacent-frame motion: ${maxMotion.toFixed(2)} Y-units`);
  if (maxMotion < 0.5) {
    console.error('FAIL: encoded video frames do not vary — blank capture');
    process.exit(1);
  }
  if (videoDurationS < 8 || videoDurationS > 15) {
    console.error(`FAIL: video duration ${videoDurationS.toFixed(1)}s outside the 8-15s envelope`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
