/**
 * KYN-11 lens performance probe: `pnpm lens:perf`
 *
 * Headed GPU Chromium on the real /explore stage: frame-time p50/p95 for
 * FAN and ANALYST (with the rail and X-Ray overlay), the accessible
 * panel's bounded update cadence, and lifecycle stability across repeated
 * lens switching (one canvas, bounded listeners, no duplicated loops).
 * Machine/GPU disclosed via the WebGL renderer string.
 */
import { execSync, spawn } from 'node:child_process';
import { chromium, type Page } from 'playwright';

const PORT = 3189;
const BASE = `http://127.0.0.1:${PORT}`;

async function startServer(): Promise<() => Promise<void>> {
  const child = spawn('pnpm', ['--filter', '@kyneloom/web', 'start', '--port', String(PORT)], {
    shell: true,
    stdio: 'pipe',
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
        for (const line of out.split('\n')) {
          if (line.includes(`:${PORT}`) && line.includes('LISTENING')) {
            const pid = line.trim().split(/\s+/).at(-1);
            if (pid && pid !== '0') execSync(`taskkill /F /T /PID ${pid}`);
          }
        }
      } catch {
        /* best effort */
      }
    } else {
      child.kill('SIGTERM');
    }
  };
}

interface FrameStats {
  frames: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanFps: number;
}

const COLLECT_FRAMES = `(durationMs) => new Promise((resolve) => {
  const times = [];
  let last = performance.now();
  const start = last;
  const tick = (now) => {
    times.push(now - last);
    last = now;
    if (now - start < durationMs) requestAnimationFrame(tick);
    else {
      const sorted = [...times].sort((a, b) => a - b);
      const mean = times.reduce((t, v) => t + v, 0) / times.length;
      resolve({
        frames: times.length,
        p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(2)),
        p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)),
        maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
        meanFps: Math.round(1000 / mean),
      });
    }
  };
  requestAnimationFrame(tick);
})`;

async function measureFrames(page: Page, ms: number): Promise<FrameStats> {
  return (await page.evaluate(`(${COLLECT_FRAMES})(${ms})`)) as FrameStats;
}

async function main(): Promise<void> {
  const stopServer = await startServer();
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--window-position=60,40',
      '--window-size=1300,940',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    await page.goto(`${BASE}/explore`, { waitUntil: 'load' });
    await page.waitForFunction(
      () =>
        (window as { __kyneloomLens?: unknown }).__kyneloomLens !== undefined &&
        (window as { __kyneloomScene?: unknown }).__kyneloomScene !== undefined,
      undefined,
      { timeout: 45_000 },
    );
    await page.waitForTimeout(2000);

    const gpu =
      (await page.evaluate(() => {
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl2');
          if (gl === null) return null;
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (ext === null) return null;
          return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
        } catch {
          return null;
        }
      })) ?? 'unavailable';
    const ua = await page.evaluate(() => navigator.userAgent);

    const fan = await measureFrames(page, 5000);
    await page.getByRole('radio', { name: 'Analyst', exact: true }).click();
    await page.waitForTimeout(900);
    const analyst = await measureFrames(page, 5000);
    await page.getByRole('button', { name: 'Show X-Ray' }).click();
    await page.waitForTimeout(800);
    const analystXray = await measureFrames(page, 5000);
    await page.getByRole('button', { name: 'Show X-Ray' }).click();
    await page.getByRole('radio', { name: 'Accessible', exact: true }).click();
    await page.waitForTimeout(1200);
    const accessible = await measureFrames(page, 5000);

    // Description update cadence: bounded (≤ ~500 ms), not per frame.
    const cadence = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="spatial-description"]');
      if (el === null) return null;
      return new Promise((resolve) => {
        const stamps: number[] = [];
        const observer = new MutationObserver(() => stamps.push(performance.now()));
        observer.observe(el, { childList: true, subtree: true, characterData: true });
        setTimeout(() => {
          observer.disconnect();
          const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
          resolve({
            updates: stamps.length,
            minGapMs: gaps.length > 0 ? Math.round(Math.min(...gaps)) : null,
          });
        }, 4000);
      });
    });

    // Lifecycle stability across repeated switching.
    const before = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      listeners:
        (window as unknown as { __kynCountListeners?: () => number }).__kynCountListeners?.() ?? -1,
      perf: window.__kyneloomPerf
        ? { geometries: window.__kyneloomPerf.geometries, textures: window.__kyneloomPerf.textures }
        : null,
    }));
    for (let round = 0; round < 5; round += 1) {
      await page.getByRole('radio', { name: 'Analyst', exact: true }).click();
      await page.waitForTimeout(250);
      await page.getByRole('radio', { name: 'Fan', exact: true }).click();
      await page.waitForTimeout(250);
      await page.getByRole('radio', { name: 'Accessible', exact: true }).click();
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      listeners:
        (window as unknown as { __kynCountListeners?: () => number }).__kynCountListeners?.() ?? -1,
      perf: window.__kyneloomPerf
        ? { geometries: window.__kyneloomPerf.geometries, textures: window.__kyneloomPerf.textures }
        : null,
    }));

    console.log('KYN-11 lens performance (headed GPU Chromium)');
    console.log(`  UA: ${ua}`);
    console.log(`  GPU: ${gpu}`);
    console.log(
      `  fan 5s:        ${fan.frames} frames · p50 ${fan.p50Ms}ms · p95 ${fan.p95Ms}ms · max ${fan.maxMs}ms · ~${fan.meanFps}fps`,
    );
    console.log(
      `  analyst 5s:    ${analyst.frames} frames · p50 ${analyst.p50Ms}ms · p95 ${analyst.p95Ms}ms · max ${analyst.maxMs}ms · ~${analyst.meanFps}fps`,
    );
    console.log(
      `  analyst+xray:  ${analystXray.frames} frames · p50 ${analystXray.p50Ms}ms · p95 ${analystXray.p95Ms}ms · ~${analystXray.meanFps}fps`,
    );
    console.log(
      `  accessible 5s: ${accessible.frames} frames · p50 ${accessible.p50Ms}ms · p95 ${accessible.p95Ms}ms · ~${accessible.meanFps}fps`,
    );
    console.log(`  description cadence (4s window): ${JSON.stringify(cadence)}`);
    console.log(`  lifecycle before: ${JSON.stringify(before)}`);
    console.log(`  lifecycle after 15 switches: ${JSON.stringify(after)}`);
    await context.close();
  } finally {
    await browser.close();
    await stopServer();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
