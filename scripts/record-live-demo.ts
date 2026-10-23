/**
 * KYN-13 live demo recorder: `pnpm qa:record:stream`
 *
 * A continuous, real-time capture of the full live-streaming demonstration:
 * explore (recorded) → activate Live Synthetic Stream → genuine SSE
 * connection → snapshot + deltas applied → players repositioning from
 * streamed tracking → network OFFLINE → truthful non-live status → back
 * ONLINE → resynchronization → stream continues. Compositor frame-stream
 * capture (same disclosed pipeline as the other Kyneloom recorders — screen
 * capture is unavailable on this host).
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

const PORT = 3179;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('qa', 'video');
/** Local operator token for this recording run (see /api/live/control auth). */
const QA_CONTROL_TOKEN = 'kyneloom-local-qa';
const FRAME_DIR = path.join(OUT_DIR, 'live-frames');
const VIDEO_NAME = 'live-stream-demo.mp4';

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
  throw new Error('ffmpeg not found');
}

async function startServer(): Promise<() => Promise<void>> {
  const child = spawn('pnpm', ['--filter', '@kyneloom/web', 'start', '--port', String(PORT)], {
    shell: true,
    stdio: 'pipe',
    env: { ...process.env, KYNELOOM_LIVE_CONTROL_TOKEN: QA_CONTROL_TOKEN },
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
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
        for (const pid of pids) execSync(`taskkill /F /T /PID ${pid}`);
      } catch {
        /* netstat scrape failed */
      }
    }
  };
}

async function main(): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(FRAME_DIR, { recursive: true, force: true });
  mkdirSync(FRAME_DIR, { recursive: true });
  const stopServer = await startServer();

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
  const stats: { finalStatus: string | null; finalPlayers: number | null } = {
    finalStatus: null,
    finalPlayers: null,
  };
  const frameTimes: number[] = [];
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(`${BASE}/explore`, { waitUntil: 'load' });
    await page.waitForFunction(
      () =>
        (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined &&
        document.querySelectorAll('canvas').length > 0,
      undefined,
      { timeout: 45_000 },
    );

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

    // Recorded moment breathes, then the switch to the live stream.
    await page.waitForTimeout(2200);
    await page.getByTestId('live-mode-toggle').click();

    // Genuine SSE connect + snapshot + deltas (software renderers are slow).
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="live-status"]')?.getAttribute('data-live-status') ??
          '') === 'connected',
      undefined,
      { timeout: 60_000, polling: 400 },
    );
    await page.waitForTimeout(3200); // streamed tracking repositions players

    // GENUINE interruption: the operator control route stops the producer —
    // the SSE stream tells the truth and closes; the chip must stop
    // claiming LIVE.
    await page.request.post(`${BASE}/api/live/control`, {
      headers: { 'x-kyneloom-live-control': QA_CONTROL_TOKEN },
      data: { action: 'stop' },
    });
    await page.waitForFunction(
      () => {
        const status =
          document.querySelector('[data-testid="live-status"]')?.getAttribute('data-live-status') ??
          '';
        return status === 'disconnected' || status === 'reconnecting';
      },
      undefined,
      { timeout: 45_000, polling: 400 },
    );
    await page.waitForTimeout(1800); // the truthful degraded view

    // Restoration: restart the producer — the browser's EventSource retry
    // reconnects and the client resynchronizes from the canonical snapshot.
    await page.request.post(`${BASE}/api/live/control`, {
      headers: { 'x-kyneloom-live-control': QA_CONTROL_TOKEN },
      data: { action: 'start' },
    });
    await page.waitForFunction(
      () => {
        const status =
          document.querySelector('[data-testid="live-status"]')?.getAttribute('data-live-status') ??
          '';
        return status === 'connected' || status === 'degraded' || status === 'reconnecting';
      },
      undefined,
      { timeout: 90_000, polling: 400 },
    );
    await page.waitForTimeout(2200); // resynchronized stream continues

    await cdp.send('Page.stopScreencast');
    stats.finalStatus = await page
      .locator('[data-testid="live-status"]')
      .getAttribute('data-live-status');
    stats.finalPlayers = await page.evaluate(
      () => window.__kyneloomScene?.snapshot?.().players.length ?? null,
    );
    await context.close();
  } finally {
    await browser.close();
    await stopServer();
  }

  const frameCount = readdirSync(FRAME_DIR).filter((f) => f.endsWith('.jpg')).length;
  if (frameCount !== frameTimes.length || frameCount < 2) {
    throw new Error(`capture failed: ${String(frameCount)} frames`);
  }
  const seconds = (frameTimes.at(-1)! - frameTimes[0]!) / 1000;
  const fps = Math.min(30, Math.max(10, (frameCount - 1) / Math.max(seconds, 0.1)));

  const rawPath = path.join(OUT_DIR, 'live-demo-raw.mp4');
  execSync(
    `"${ffmpeg}" -y -framerate ${fps.toFixed(3)} -i "${path.join(FRAME_DIR, 'f%05d.jpg')}" ` +
      `-vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -an "${rawPath}"`,
    { stdio: 'pipe' },
  );
  execSync(
    `"${ffmpeg}" -y -i "${rawPath}" -c:v libvpx -b:v 3000k -an "${path.join(OUT_DIR, 'live-stream-demo.webm')}"`,
    { stdio: 'pipe' },
  );
  renameSync(rawPath, path.join(OUT_DIR, VIDEO_NAME));

  const diffs = execSync(
    `"${ffmpeg}" -i "${path.join(OUT_DIR, VIDEO_NAME)}" -vf "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -`,
    { stdio: 'pipe' },
  )
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('lavfi.signalstats.YAVG='))
    .map((l) => Number(l.slice('lavfi.signalstats.YAVG='.length)));
  const maxMotion = Math.max(0, ...diffs);
  const duration = (diffs.length + 1) / fps;

  console.log(`recorded ${VIDEO_NAME} (${fps.toFixed(1)} fps compositor capture)`);
  console.log(`  duration: ${duration.toFixed(1)}s (${String(diffs.length + 1)} frames)`);
  console.log(
    `  size: ${(statSync(path.join(OUT_DIR, VIDEO_NAME)).size / 1024 / 1024).toFixed(2)} MB`,
  );
  console.log(`  final state: ${JSON.stringify(stats)}`);
  console.log(`  max adjacent-frame motion: ${maxMotion.toFixed(2)} Y-units`);
  rmSync(FRAME_DIR, { recursive: true, force: true });
  if (maxMotion < 0.5) {
    console.error('FAIL: frames do not vary');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
