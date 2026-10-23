import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackingSample } from '@kyneloom/contracts';
import { LiveMatchService } from './service';

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
