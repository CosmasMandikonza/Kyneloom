/**
 * KYN-10 gallery performance measurement: `pnpm moments:perf`
 *
 * Headed GPU Chromium (real compositing — headless SwiftShader numbers are
 * not representative for interaction cost) on the populated /moments grid:
 *   - frame-time distribution (p50/p95/max) at idle and during a pointer
 *     sweep across all twelve cards,
 *   - JS heap + DOM node/listener counts via CDP,
 *   - tilt rAF loop activity after the pointer leaves (must be zero),
 *   - preview resource loading (count, transfer).
 * Machine/GPU disclosed via chrome://gpu summary lines in the output.
 */
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 3183;
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

async function measureFrames(page: import('playwright').Page, ms: number): Promise<FrameStats> {
  return page.evaluate((durationMs) => {
    return new Promise<FrameStats>((resolve) => {
      const times: number[] = [];
      let last = performance.now();
      const start = last;
      const tick = (now: number): void => {
        times.push(now - last);
        last = now;
        if (now - start < durationMs) requestAnimationFrame(tick);
        else {
          const sorted = [...times].sort((a, b) => a - b);
          const mean = times.reduce((t, v) => t + v, 0) / times.length;
          resolve({
            frames: times.length,
            p50Ms: Number((sorted[Math.floor(sorted.length * 0.5)] ?? 0).toFixed(2)),
            p95Ms: Number((sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2)),
            maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
            meanFps: Math.round(1000 / mean),
          });
        }
      };
      requestAnimationFrame(tick);
    });
  }, ms);
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
    await page.goto(`${BASE}/moments`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (window as { __kyneloomMoments?: unknown }).__kyneloomMoments !== undefined,
      undefined,
      { timeout: 20_000 },
    );
    // Scroll the full grid into view so every card mounts its imagery.
    await page.evaluate(() => {
      const last = document.querySelector('.moments__provenance');
      last?.scrollIntoView();
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1500);

    const cdp = await context.newCDPSession(page);
    const gpuInfo = (await cdp.send('SystemInfo.getInfo')) as {
      gpu?: { devices?: { description?: string }[]; renderer?: string };
    };
    const gpu =
      gpuInfo.gpu !== undefined
        ? `${gpuInfo.gpu.devices?.[0]?.description ?? 'unknown GPU'} · ${gpuInfo.gpu.renderer ?? ''}`.trim()
        : 'unknown';
    const ua = await page.evaluate(() => navigator.userAgent);

    const idle = await measureFrames(page, 5000);

    // Pointer sweep across every card (the heaviest gallery interaction).
    const cards = page.locator('.mcard');
    const count = await cards.count();
    const boxes = [];
    for (let i = 0; i < count; i += 1) {
      const box = await cards.nth(i).boundingBox();
      if (box !== null) boxes.push(box);
    }
    const sweep = measureFrames(page, 6000);
    const stepMs = 6000 / Math.max(1, boxes.length * 3);
    for (const box of boxes) {
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 2 });
      await page.waitForTimeout(stepMs);
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 2 });
      await page.waitForTimeout(stepMs);
    }
    const during = await sweep;
    await page.mouse.move(4, 4, { steps: 4 });
    await page.waitForTimeout(1500);
    const settle = await measureFrames(page, 3000);

    const loopsAfterLeave = await page.evaluate(
      () =>
        (
          window as { __kyneloomMoments?: { activeTiltLoops(): number } }
        ).__kyneloomMoments?.activeTiltLoops() ?? -1,
    );
    const dom = await page.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      images: document.querySelectorAll('img').length,
      loadedImages: Array.from(document.images).filter((i) => i.complete && i.naturalWidth > 0)
        .length,
      canvases: document.querySelectorAll('canvas').length,
    }));
    const heap = await cdp.send('Performance.getMetrics');
    const jsHeap = heap.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? -1;
    const listeners = heap.metrics.find((m) => m.name === 'JSEventListeners')?.value ?? -1;
    const resources = await page.evaluate(() =>
      performance.getEntriesByType('resource').filter((r) => r.name.includes('moment-previews')),
    );

    console.log('KYN-10 gallery performance (headed GPU Chromium)');
    console.log(`  UA: ${ua}`);
    console.log(`  GPU: ${gpu}`);
    console.log(
      `  idle 5s:      ${idle.frames} frames · p50 ${idle.p50Ms}ms · p95 ${idle.p95Ms}ms · max ${idle.maxMs}ms · ~${idle.meanFps}fps`,
    );
    console.log(
      `  sweep 6s:     ${during.frames} frames · p50 ${during.p50Ms}ms · p95 ${during.p95Ms}ms · max ${during.maxMs}ms · ~${during.meanFps}fps`,
    );
    console.log(
      `  settle 3s:    ${settle.frames} frames · p50 ${settle.p50Ms}ms · p95 ${settle.p95Ms}ms · ~${settle.meanFps}fps`,
    );
    console.log(`  tilt rAF loops after pointer left: ${loopsAfterLeave}`);
    console.log(
      `  DOM: ${dom.nodes} nodes · ${dom.loadedImages}/${dom.images} images loaded · ${dom.canvases} canvases`,
    );
    console.log(`  JS heap: ${(jsHeap / 1048576).toFixed(1)} MB · event listeners: ${listeners}`);
    console.log(`  preview resources: ${resources.length}`);
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
