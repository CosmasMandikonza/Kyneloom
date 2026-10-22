/**
 * KYN-13 — `pnpm live:perf`: measure the LOCAL streaming transport's honest
 * ingest-to-publish latency from a real production-server run (start
 * producer → collect trace-id-bearing samples from /api/live/status →
 * stop). Writes qa/perf-live.txt. These numbers describe the local SSE
 * path only; no Azure service is running and none is claimed.
 */
import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 3181;
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET_SAMPLES = 160;

interface StatusBody {
  status: {
    running: boolean;
    matchId: string;
    seq: number;
    quarantined: number;
    archivedEnvelopes: number;
    subscribers: number;
    droppedSubscribers: number;
    projectionMsMean: number;
  };
  latency: { traceId: string; kind: string; ingestToPublishMs: number }[];
  integrityFingerprint: string;
}

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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const stopServer = await startServer();
  try {
    const start = await fetch(`${BASE}/api/live/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
    if (!start.ok) throw new Error(`control start failed: ${String(start.status)}`);

    const sampledTraceIds = new Set<string>();
    let finalStatus: StatusBody | null = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${BASE}/api/live/status`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as StatusBody;
      finalStatus = body;
      for (const sample of body.latency) sampledTraceIds.add(sample.traceId);
      if (sampledTraceIds.size >= TARGET_SAMPLES) break;
      await new Promise((r) => setTimeout(r, 1200));
    }
    await fetch(`${BASE}/api/live/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });

    if (finalStatus === null) throw new Error('no status observed');
    // The endpoint exposes the last 500 samples; refetch once after stop for
    // the freshest window, keeping the union of trace ids we observed live.
    const tailRes = await fetch(`${BASE}/api/live/status`, { signal: AbortSignal.timeout(3000) });
    const tail = (await tailRes.json()) as StatusBody;
    const samples = tail.latency;
    for (const sample of samples) sampledTraceIds.add(sample.traceId);
    const values = samples.map((s) => s.ingestToPublishMs).sort((a, b) => a - b);
    if (values.length === 0) throw new Error('no latency samples collected');

    const byKind = new Map<string, number[]>();
    for (const s of samples) {
      const list = byKind.get(s.kind) ?? [];
      list.push(s.ingestToPublishMs);
      byKind.set(s.kind, list);
    }
    const kindLines = [...byKind.entries()]
      .map(([kind, list]) => {
        const sorted = [...list].sort((a, b) => a - b);
        return `  ${kind}: n=${String(sorted.length)} p50=${percentile(sorted, 50)}ms p95=${percentile(sorted, 95)}ms max=${String(sorted.at(-1))}ms`;
      })
      .join('\n');

    const report = [
      '# KYN-13 live streaming latency — LOCAL transport (production server, SSE fan-out)',
      `# measured ${new Date().toISOString()} · ${String(values.length)} samples · ${String(sampledTraceIds.size)} distinct trace ids`,
      '# ingest-to-publish: producer envelope accepted → authoritative frame published to subscribers',
      '# HONEST SCOPE: local Node process; no Azure service was running (Event Hubs/Web PubSub NOT deployed).',
      '# These are not cloud numbers and no cloud SLA is claimed.',
      '',
      `overall: n=${String(values.length)} min=${String(values[0])}ms p50=${percentile(values, 50)}ms p95=${percentile(values, 95)}ms max=${String(values.at(-1))}ms`,
      'by frame kind:',
      kindLines,
      '',
      `final state: match=${tail.status.matchId} seq=${String(tail.status.seq)} quarantined=${String(tail.status.quarantined)} archived=${String(tail.status.archivedEnvelopes)} projectionMean=${String(Math.round(tail.status.projectionMsMean))}ms fingerprint=${tail.integrityFingerprint.slice(0, 16)}…`,
      `sample trace ids (first 8): ${samples
        .slice(0, 8)
        .map((s) => s.traceId)
        .join(', ')}`,
      '',
    ].join('\n');
    writeFileSync(path.resolve('qa', 'perf-live.txt'), report);
    console.log(report);
  } finally {
    await stopServer();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
