import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { TrackingSample } from '@kyneloom/contracts';
import {
  LiveSyncController,
  STREAM_CONTRACT_VERSION,
  type StreamEnvelope,
  type SyncEvent,
} from '@kyneloom/match-core';
import { LiveMatchService } from './service';

/**
 * KYN-13 review round 2 — the ACTUAL service lifecycle rotates the stream
 * session on every producer restart (not just hand-built workers): the
 * generation id changes, the broadcast sequence resets for the new
 * generation, and stale frames from the DEAD session can never invalidate
 * the newly synchronized stream. Producer emission is quiesced (stop)
 * right after each start so the frames under test are deterministic;
 * ingest and delivery are generation-independent code paths.
 */

function trackingEnvelope(sampleTimeMs: number, xM: number, envelopeId: string): StreamEnvelope {
  return {
    contractVersion: STREAM_CONTRACT_VERSION,
    envelopeId,
    matchId: 'synthetic-derby-01',
    kind: 'tracking',
    tracking: {
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
    } as TrackingSample,
    emittedAt: Date.now(),
    traceId: 'trc-rot',
  };
}

const archiveDir = path.join(process.cwd(), '.live-archive');

afterAll(() => {
  rmSync(archiveDir, { recursive: true, force: true });
});

describe('LiveMatchService session rotation (real stop/start lifecycle)', () => {
  it('restart allocates a NEW generation; sequence resets; stale old-session frames cannot invalidate the new stream', async () => {
    const service = LiveMatchService.get();

    // --- Generation 1 -----------------------------------------------------
    await service.start({ sessionId: 'gen-1', speed: 4 });
    service.stop(); // quiesce the producer; frames below are deterministic
    expect(service.status.sessionId).toBe('gen-1');
    service.subscribe('viewer-1');
    service.ingest([trackingEnvelope(1000, 1, 'env-rot-1')]);
    const gen1Frames = service.drain('viewer-1', 16);
    const gen1Snapshot = gen1Frames.find((f) => f.type === 'snapshot');
    const gen1Delta = gen1Frames.find((f) => f.type === 'delta');
    if (gen1Snapshot === undefined || gen1Delta === undefined) {
      throw new Error('generation 1 snapshot/delta expected');
    }
    expect(gen1Snapshot.sessionId).toBe('gen-1');
    expect(gen1Delta.sessionId).toBe('gen-1');
    expect(gen1Delta.seq).toBe(1);

    // --- Restart: generation 2 (the REAL operator stop/start path) ---------
    await service.start({ sessionId: 'gen-2', speed: 4 });
    service.stop();
    expect(service.status.sessionId).toBe('gen-2');
    const viewer2 = service.subscribe('viewer-2');
    void viewer2;
    const gen2Frames = service.drain('viewer-2', 16);
    const gen2Snapshot = gen2Frames.find((f) => f.type === 'snapshot');
    if (gen2Snapshot === undefined) throw new Error('generation 2 snapshot expected');
    expect(gen2Snapshot.sessionId).toBe('gen-2');
    service.ingest([trackingEnvelope(4_000_000, 5, 'env-rot-2')]);
    const gen2Delta = service.drain('viewer-2', 16).find((f) => f.type === 'delta');
    if (gen2Delta === undefined) throw new Error('generation 2 delta expected');
    expect(gen2Delta.sessionId).toBe('gen-2');
    expect(gen2Delta.seq).toBe(1); // the new generation's sequence space resets

    // --- Stale generation frames cannot invalidate the new stream ----------
    // A viewer synchronized on generation 2 receives a DELAYED frame from
    // the dead generation 1 (seq 1 in the OLD sequence space).
    const events: SyncEvent[] = [];
    const viewer = new LiveSyncController({
      onEvent: (event) => events.push(event),
      fetchSnapshot: async () => service.snapshotFrame(),
    });
    expect(viewer.applyFrame(gen2Snapshot)).toBe(true);
    expect(viewer.applyFrame(gen2Delta)).toBe(true);
    const gapsBefore = events.filter((e) => e.type === 'gap').length;
    expect(viewer.applyFrame(gen1Delta)).toBe(false); // stale generation: ignored
    expect(events.filter((e) => e.type === 'gap').length).toBe(gapsBefore); // no false gap
    expect(viewer.currentStateVersion).toBe(service.status.stateVersion); // intact

    // A CURRENT-generation delta still applies contiguously afterwards.
    service.ingest([trackingEnvelope(4_000_100, 6, 'env-rot-3')]);
    const freshDelta = service.drain('viewer-2', 16).find((f) => f.type === 'delta');
    if (freshDelta === undefined) throw new Error('fresh delta expected');
    expect(freshDelta.sessionId).toBe('gen-2');
    expect(viewer.applyFrame(freshDelta)).toBe(true);
    expect(viewer.currentStateVersion).toBe(service.status.stateVersion);

    // --- Idempotent start while RUNNING keeps the same generation ----------
    await service.start({ sessionId: 'gen-3', speed: 4 });
    await service.start({ sessionId: 'gen-4-must-be-ignored', speed: 4 });
    expect(service.status.sessionId).toBe('gen-3');
    service.stop();

    // --- Default (non-overridden) restart allocates a fresh unique id ------
    await service.start({ speed: 4 });
    service.stop();
    const defaulted = service.status.sessionId;
    expect(defaulted).not.toBe('gen-3');
    expect(defaulted).toMatch(/^live-\d+-\d+$/);
  });
});
