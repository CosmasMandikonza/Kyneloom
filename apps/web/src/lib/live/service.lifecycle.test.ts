import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackingSample } from '@kyneloom/contracts';
import { LiveMatchService } from './service';
// The route module resolves the SAME gated loader mock in this file.
import { GET as liveStreamGET } from '@/app/api/live/stream/route';

/**
 * KYN-13 review round 4, blocker B — the REAL service lifecycle under
 * concurrency, with the async fixture load held at a deterministic gate:
 * concurrent starts share ONE initialization (one producer, one worker, one
 * generation); a stop during initialization invalidates it; failed
 * initialization stays recoverable; a stop leaves no orphan producer; a
 * restart overlapping initialization cannot activate obsolete work.
 */

interface Gate {
  calls: number;
  resolvers: ((value: unknown) => void)[];
  mode: 'hold' | 'ok' | 'fail';
}

const gate = vi.hoisted(() => ({}) as Gate);

vi.mock('@/lib/match-fixture', () => ({
  loadGoldenMatch: () =>
    new Promise((resolve, reject) => {
      gate.calls += 1;
      if (gate.mode === 'fail') {
        reject(new Error('fixture unavailable (test)'));
        return;
      }
      gate.resolvers.push(resolve);
    }),
}));

function trackingSample(sampleTimeMs: number, xM: number): TrackingSample {
  return {
    schemaVersion: '1.0',
    matchId: 'synthetic-derby-01',
    sampleTimeMs,
    entityId: 'home-01',
    xM,
    yM: 2,
    zM: 0,
    origin: 'synthetic_ground_truth',
    confidence: 1,
    visibility: 'tracked',
    sourceFrameId: `frame-${String(Math.round(sampleTimeMs / 100))}`,
  } as TrackingSample;
}

function releaseNextFixture(): void {
  const resolve = gate.resolvers.shift();
  resolve?.({
    ok: true,
    data: {
      projected: {
        acceptedEvents: [],
        acceptedTracking: [trackingSample(1000, 1), trackingSample(1100, 2)],
      },
    },
  });
}

/** Release the held load as a FAILED fixture read (initialize throws). */
function failNextFixture(): void {
  const resolve = gate.resolvers.shift();
  resolve?.({ ok: false, error: 'fixture unavailable (test)' });
}

async function waitCalls(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (gate.calls < count) {
    if (Date.now() > deadline)
      throw new Error(`fixture loads: ${String(gate.calls)} < ${String(count)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const archiveDir = path.join(process.cwd(), '.live-archive');

beforeEach(() => {
  gate.calls = 0;
  gate.resolvers = [];
  gate.mode = 'hold';
});

afterAll(() => {
  rmSync(archiveDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('LiveMatchService single-flight initialization (real lifecycle)', () => {
  // FIRST IN FILE (deterministic state): the canceled-startup interleaving
  // needs the pristine post-boot idle state — auto-start permitted — which
  // only exists before this process's first stop().
  it('round 5 — a GET whose auto-start was canceled by an overlapping stop never subscribes as live', async () => {
    const service = LiveMatchService.get();
    // A public GET starts initialization... which the operator cancels.
    const resPromise = liveStreamGET(new Request('http://127.0.0.1/api/live/stream?speed=4'));
    await waitCalls(1);
    service.stop(); // overlapping stop cancels the GET's startup
    releaseNextFixture(); // the canceled load abandons (never activates)
    const res = await resPromise;
    expect(res.status).toBe(200); // the SSE stream still opens truthfully
    // Read it to completion: hello, then a truthful disconnected close —
    // the viewer is NEVER served a live stream (no delta, and no snapshot
    // of a startup that never activated) for the canceled startup.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      text += decoder.decode(read.value, { stream: true });
    }
    expect(text).toContain('event: hello');
    expect(text).toContain('disconnected');
    expect(text).not.toContain('event: delta');
    expect(service.status.running).toBe(false);
    expect(gate.calls).toBe(1);
  });

  it('concurrent starts share ONE initialization: one load, one generation, one active producer', async () => {
    const service = LiveMatchService.get();
    service.stop();
    // THREE simultaneous viewers hitting the stopped service (the parallel
    // GET auto-start entry path).
    const starts = [
      service.start({ sessionId: 'shared-gen', speed: 4 }),
      service.start({ sessionId: 'ignored-1', speed: 4 }),
      service.start({ sessionId: 'ignored-2', speed: 4 }),
    ];
    await waitCalls(1);
    // Nothing activated while the fixture load is in flight.
    expect(service.status.running).toBe(false);
    expect(gate.calls).toBe(1); // single flight — no second loader ran
    releaseNextFixture();
    await Promise.all(starts);
    expect(service.status.running).toBe(true);
    expect(service.status.sessionId).toBe('shared-gen'); // one generation
    // One authoritative worker: manual admission publishes on it.
    service.ingest([
      {
        contractVersion: 'kyneloom-live-wire-v2',
        envelopeId: 'env-life-1',
        matchId: 'synthetic-derby-01',
        kind: 'tracking',
        tracking: trackingSample(4_000_000, 9),
        emittedAt: 1,
        traceId: 'trc-life',
      },
    ]);
    expect(service.status.seq).toBeGreaterThan(0);
    service.stop();
  });

  it('a stop DURING in-flight initialization prevents activation (no obsolete generation)', async () => {
    const service = LiveMatchService.get();
    service.stop();
    const abandoned = service.start({ sessionId: 'abandoned-gen', speed: 4 });
    await waitCalls(1);
    service.stop(); // the stop is the final word mid-initialization
    releaseNextFixture();
    await abandoned;
    expect(service.status.running).toBe(false);
    expect(service.status.sessionId).not.toBe('abandoned-gen');
    // A subsequent genuine start works cleanly.
    const restarted = service.start({ sessionId: 'after-stop-gen', speed: 4 });
    await waitCalls(2);
    releaseNextFixture();
    await restarted;
    expect(service.status.running).toBe(true);
    expect(service.status.sessionId).toBe('after-stop-gen');
    service.stop();
  });

  it('failed initialization rejects and the service stays recoverable', async () => {
    const service = LiveMatchService.get();
    service.stop();
    gate.mode = 'fail';
    await expect(service.start({ sessionId: 'never', speed: 4 })).rejects.toThrow(
      'fixture unavailable',
    );
    expect(service.status.running).toBe(false);
    gate.mode = 'hold';
    const retry = service.start({ sessionId: 'retry-gen', speed: 4 });
    await waitCalls(1);
    releaseNextFixture();
    await retry;
    expect(service.status.running).toBe(true);
    expect(service.status.sessionId).toBe('retry-gen');
    service.stop();
  });

  it('a restart overlapping initialization cannot reactivate the superseded generation', async () => {
    const service = LiveMatchService.get();
    service.stop();
    const stale = service.start({ sessionId: 'stale-gen', speed: 4 });
    await waitCalls(1);
    service.stop();
    const fresh = service.start({ sessionId: 'fresh-gen', speed: 4 });
    // Release the stale load: its initialization abandons; the fresh start
    // becomes the new authority and performs its own load.
    releaseNextFixture();
    await stale;
    await waitCalls(2);
    releaseNextFixture();
    await fresh;
    expect(service.status.running).toBe(true);
    expect(service.status.sessionId).toBe('fresh-gen');
    service.stop();
  });

  it('round 5 — waiters issued before a stop NEVER fork a fresh initialization after it', async () => {
    const service = LiveMatchService.get();
    service.stop();
    // start(A) begins loading and stays pending; B and C arrive and wait.
    const a = service.start({ sessionId: 'gen-a-pending', speed: 4 });
    await waitCalls(1);
    const b = service.start({ sessionId: 'gen-b-waiter', speed: 4 });
    const c = service.start({ sessionId: 'gen-c-waiter', speed: 4 });
    await Promise.resolve(); // let the share path run (no new load expected)
    expect(gate.calls).toBe(1);
    // The operator stop invalidates EVERY request issued under this epoch.
    service.stop();
    releaseNextFixture(); // A's load completes → its initialization abandons
    await Promise.all([a, b, c]);
    // Nobody revived: no new initialization, no producer, no generation.
    expect(service.status.running).toBe(false);
    expect(gate.calls).toBe(1);
    expect(service.status.sessionId).not.toBe('gen-b-waiter');
    expect(service.status.sessionId).not.toBe('gen-c-waiter');
    // A FRESH, explicitly issued start may begin a new generation.
    const fresh = service.start({ sessionId: 'gen-after', speed: 4 });
    await waitCalls(2);
    releaseNextFixture();
    await fresh;
    expect(service.status.running).toBe(true);
    expect(service.status.sessionId).toBe('gen-after');
    service.stop();
  });

  it('round 5 — a SHARED initialization failure rejects all waiters without duplicate retries', async () => {
    const service = LiveMatchService.get();
    service.stop();
    const a = service.start({ sessionId: 'fail-a', speed: 4 });
    await waitCalls(1);
    const b = service.start({ sessionId: 'fail-b', speed: 4 });
    const c = service.start({ sessionId: 'fail-c', speed: 4 });
    // The held load completes as a FAILED fixture read.
    failNextFixture();
    const results = await Promise.allSettled([a, b, c]);
    // Same failure for everyone; no waiter forked its own retry loader.
    expect(gate.calls).toBe(1);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect(String(r.reason)).toContain('fixture unavailable');
    }
    expect(service.status.running).toBe(false);
    // A later EXPLICIT retry succeeds — exactly one new load.
    const retry = service.start({ sessionId: 'retry-gen-5', speed: 4 });
    await waitCalls(2);
    releaseNextFixture();
    await retry;
    expect(service.status.running).toBe(true);
    expect(gate.calls).toBe(2);
    service.stop();
  });

  it('round 5 — rapid stop→start→stop→start leaves ONLY the latest authorized generation active', async () => {
    const service = LiveMatchService.get();
    service.stop();
    const s1 = service.start({ sessionId: 'rapid-1', speed: 4 });
    await waitCalls(1);
    releaseNextFixture();
    await s1;
    expect(service.status.sessionId).toBe('rapid-1');
    service.stop();
    const s2 = service.start({ sessionId: 'rapid-2', speed: 4 });
    await waitCalls(2);
    releaseNextFixture();
    await s2;
    expect(service.status.sessionId).toBe('rapid-2');
    service.stop();
    const s3 = service.start({ sessionId: 'rapid-3', speed: 4 });
    await waitCalls(3);
    releaseNextFixture();
    await s3;
    expect(service.status.running).toBe(true);
    expect(service.status.sessionId).toBe('rapid-3');
    expect(gate.calls).toBe(3); // one load per genuinely new session
    service.stop();
  });

  it('round 5 — an authorized stop STAYS stopped against public auto-start (viewer reconnects cannot revive)', async () => {
    const service = LiveMatchService.get();
    service.stop();
    expect(service.isOperatorStopped).toBe(true);
    // Initial idle startup is still allowed for the public demo.
    const boot = service.start({ sessionId: 'boot-gen', speed: 4 });
    await waitCalls(1);
    releaseNextFixture();
    await boot;
    expect(service.isOperatorStopped).toBe(false);
    expect(service.status.running).toBe(true);
    // Operator stop flips the state; repeated public GETs must not revive.
    service.stop();
    expect(service.isOperatorStopped).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      const res = await liveStreamGET(new Request('http://127.0.0.1/api/live/stream?speed=4'));
      expect(res.status).toBe(200); // SSE (truthful snapshot + close), never a restart
      expect(gate.calls).toBe(1); // NO fixture load was triggered
      expect(service.status.running).toBe(false);
      await res.body!.cancel();
    }
    // An explicitly issued start (authorized control path) resumes.
    const resume = service.start({ sessionId: 'resumed-gen', speed: 4 });
    await waitCalls(2);
    releaseNextFixture();
    await resume;
    expect(service.status.running).toBe(true);
    expect(service.isOperatorStopped).toBe(false);
    expect(service.status.sessionId).toBe('resumed-gen');
    service.stop();
  });

  it('stop leaves NO orphan producer: the authoritative stream freezes', async () => {
    const service = LiveMatchService.get();
    service.stop();
    const started = service.start({ sessionId: 'orphan-gen', speed: 4 });
    await waitCalls(1);
    releaseNextFixture();
    await started;
    // The producer replays the gated fixture's samples — observe it live.
    const deadline = Date.now() + 10_000;
    while (service.status.archivedEnvelopes === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(service.status.archivedEnvelopes).toBeGreaterThan(0);
    service.stop();
    // Observation window (orphan detection, not ordering): nothing may be
    // admitted or published after the stop.
    const seqAtStop = service.status.seq;
    const archivedAtStop = service.status.archivedEnvelopes;
    await new Promise((r) => setTimeout(r, 400));
    expect(service.status.running).toBe(false);
    expect(service.status.seq).toBe(seqAtStop);
    expect(service.status.archivedEnvelopes).toBe(archivedAtStop);
  });
});
